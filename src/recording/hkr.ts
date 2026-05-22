// .hkr (JSON) serializer + parser. Single-version schema; bumps to v2 will
// add explicit branching here.

import type { HkrSession, HkrEvent, LayoutSnapshot } from './types.js';

export class HkrParseError extends Error {}

export function serializeHkr(session: HkrSession): string {
  return JSON.stringify(session, null, 2);
}

function isTuningMode(s: unknown): s is '5' | '7' | 'E' {
  return s === '5' || s === '7' || s === 'E';
}
function isPedalMode(s: unknown): s is 'sustain' | 'sostenuto' {
  return s === 'sustain' || s === 'sostenuto';
}

function parseSnapshot(o: unknown): LayoutSnapshot {
  if (!o || typeof o !== 'object') throw new HkrParseError('snapshot missing');
  const s = o as Record<string, unknown>;
  if (!isTuningMode(s.tuning)) throw new HkrParseError('snapshot.tuning invalid');
  if (typeof s.septimalEnabled !== 'boolean') throw new HkrParseError('snapshot.septimalEnabled invalid');
  if (typeof s.equalEnabled !== 'boolean') throw new HkrParseError('snapshot.equalEnabled invalid');
  if (typeof s.septimalW !== 'number') throw new HkrParseError('snapshot.septimalW invalid');
  if (typeof s.instrument !== 'string') throw new HkrParseError('snapshot.instrument invalid');
  if (!isPedalMode(s.pedalMode)) throw new HkrParseError('snapshot.pedalMode invalid');
  if (typeof s.refHz !== 'number') throw new HkrParseError('snapshot.refHz invalid');
  return {
    tuning: s.tuning,
    septimalEnabled: s.septimalEnabled,
    equalEnabled: s.equalEnabled,
    septimalW: s.septimalW,
    instrument: s.instrument,
    pedalMode: s.pedalMode,
    refHz: s.refHz,
  };
}

function parseEvent(o: unknown): HkrEvent | null {
  if (!o || typeof o !== 'object') return null;
  const e = o as Record<string, unknown>;
  if (typeof e.t !== 'number') return null;
  switch (e.k) {
    case 'on':
      if (typeof e.q !== 'number' || typeof e.r !== 'number' || typeof e.v !== 'number') return null;
      return { t: e.t, k: 'on', q: e.q, r: e.r, v: e.v };
    case 'off':
      if (typeof e.q !== 'number' || typeof e.r !== 'number') return null;
      return { t: e.t, k: 'off', q: e.q, r: e.r };
    case 'pa':
      if (typeof e.q !== 'number' || typeof e.r !== 'number' || typeof e.p !== 'number') return null;
      return { t: e.t, k: 'pa', q: e.q, r: e.r, p: e.p };
    case 'cc4':
      if (typeof e.v !== 'number') return null;
      return { t: e.t, k: 'cc4', v: e.v };
    case 'cc64':
      if (typeof e.v !== 'number') return null;
      return { t: e.t, k: 'cc64', v: e.v };
    case 'warn':
      if (typeof e.msg !== 'string') return null;
      return { t: e.t, k: 'warn', msg: e.msg };
    default:
      return null;
  }
}

export function parseHkr(text: string): HkrSession {
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch (e) { throw new HkrParseError('invalid JSON: ' + (e as Error).message); }
  if (!obj || typeof obj !== 'object') throw new HkrParseError('root not an object');
  const o = obj as Record<string, unknown>;
  if (o.format !== 'hkr') throw new HkrParseError('not an .hkr file (format != "hkr")');
  if (o.version !== 1) throw new HkrParseError('unsupported .hkr version: ' + String(o.version));
  if (typeof o.createdAt !== 'string') throw new HkrParseError('createdAt missing');
  if (typeof o.durationSec !== 'number') throw new HkrParseError('durationSec missing');
  const snapshot = parseSnapshot(o.snapshot);
  if (!Array.isArray(o.events)) throw new HkrParseError('events missing');
  const events: HkrEvent[] = [];
  for (const raw of o.events) {
    const ev = parseEvent(raw);
    if (ev) events.push(ev);
  }
  return {
    format: 'hkr',
    version: 1,
    createdAt: o.createdAt,
    durationSec: o.durationSec,
    timing: { unit: 'audioCtxSec', epoch: 0 },
    snapshot,
    events,
  };
}
