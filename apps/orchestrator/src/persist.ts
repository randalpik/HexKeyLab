// localStorage persistence for the orchestrator session — survives reloads
// (including Vite HMR during development). Only the small, serializable parts:
// the capture config, the chosen velocity bins, and the last-selected device
// IDs (so the Connect dropdowns repopulate). NOT the live CaptureDevice (a
// live AudioContext/MIDI handle can't serialize — you re-click Connect) and
// NOT the captured PCM (tens to hundreds of MB; lives in capture/store.ts).

import type { CaptureConfig, VelocityBin } from './state.js';

const KEY = 'hkl-orchestrator-session-v1';

export interface PersistedSession {
  config?: Partial<CaptureConfig>;
  bins?: VelocityBin[];
  midiOutId?: string;
  audioInId?: string;
}

export function loadPersisted(): PersistedSession {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v as PersistedSession : {};
  } catch { return {}; }
}

/** Merge a patch into the persisted blob and write it back. */
export function patchPersisted(patch: Partial<PersistedSession>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPersisted(), ...patch }));
  } catch { /* storage unavailable / quota — non-fatal */ }
}

export function clearPersisted(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
