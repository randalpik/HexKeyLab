// MPE channel allocator. Member channels 2..16 (lower-zone MPE); channel 1
// reserved as the manager. LRU eviction policy: when all members are in use,
// steal the channel held longest (oldest-acquired). Eviction is rare in
// practice but well-defined so exports don't fail catastrophically.

import type { KeyId } from '../types.js';

const MIN_MEMBER = 2;
const MAX_MEMBER = 16;

/* Returned channels are 1-indexed (2..16) to match the SysEx convention. The
   midi-file library expects 0-indexed channel numbers, so callers must subtract
   1 when emitting events. */
export class MpeAllocator {
  private free: number[] = [];          /* MRU-released channels first (popped) */
  private inUse: Map<KeyId, number> = new Map();
  private order: KeyId[] = [];           /* oldest-acquired first */

  constructor() { this.reset(); }

  reset(): void {
    this.inUse.clear();
    this.order = [];
    this.free = [];
    for (let ch = MAX_MEMBER; ch >= MIN_MEMBER; ch--) this.free.push(ch);
  }

  /** Returns the channel assigned to `key`. If `evicted` is non-null, the
   *  caller must emit a note-off for the evicted key on the returned channel
   *  before its new note-on. */
  acquire(key: KeyId): { channel: number; evicted: KeyId | null } {
    const existing = this.inUse.get(key);
    if (existing !== undefined) return { channel: existing, evicted: null };
    if (this.free.length > 0) {
      const ch = this.free.pop()!;
      this.inUse.set(key, ch);
      this.order.push(key);
      return { channel: ch, evicted: null };
    }
    /* All 15 member channels in use — evict the oldest. */
    const evictKey = this.order.shift()!;
    const ch = this.inUse.get(evictKey)!;
    this.inUse.delete(evictKey);
    this.inUse.set(key, ch);
    this.order.push(key);
    return { channel: ch, evicted: evictKey };
  }

  /** Return channel for `key`, freeing it. Returns null if `key` wasn't held. */
  release(key: KeyId): number | null {
    const ch = this.inUse.get(key);
    if (ch === undefined) return null;
    this.inUse.delete(key);
    const i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
    this.free.push(ch);
    return ch;
  }

  /** Lookup without acquiring — for emitting CC/PA on a held voice's channel. */
  channelOf(key: KeyId): number | null {
    const ch = this.inUse.get(key);
    return ch === undefined ? null : ch;
  }
}
