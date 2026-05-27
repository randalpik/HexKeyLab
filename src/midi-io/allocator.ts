// MPE channel allocator. Member channels 2..16 (lower-zone MPE); channel 1
// reserved as the manager. LRU eviction policy: when all members are in use,
// steal the channel held longest (oldest-acquired). Eviction is rare in
// practice but well-defined so exports don't fail catastrophically.

import type { KeyId } from '../types.js';

const MIN_MEMBER = 2;
const MAX_MEMBER = 16;

/* Returned channels are 1-indexed (2..16 by default) to match the SysEx
   convention. The midi-file library expects 0-indexed channel numbers, so
   callers must subtract 1 when emitting events. The channel range is
   configurable: MPE export uses the default (2..16, reserving ch1 as manager),
   while the SP-250 piano-output path uses the full 1..16 (no manager channel). */
export class MpeAllocator {
  private free: number[] = [];
  private inUse: Map<KeyId, number> = new Map();
  private order: KeyId[] = [];           /* oldest-acquired first */
  private readonly minCh: number;
  private readonly maxCh: number;
  private readonly fifo: boolean;
  private readonly exclude: Set<number>;

  /** `reuse`: 'lifo' (default) reuses the most-recently-freed channel first —
   *  fine for offline export. 'fifo' reuses the *oldest*-freed channel first
   *  (round-robin through all channels before any repeat), which the live
   *  piano-output path needs: a synth voice's release tail keeps ringing after
   *  note-off, and reusing its channel too soon makes the next note-on retune
   *  that still-sounding tail. Round-robin gives each channel maximal rest.
   *  `exclude`: 1-indexed channels to never hand out. Piano output passes [10]
   *  because General MIDI reserves channel 10 for percussion — a note-on there
   *  plays a drum map, not a pitched note from the selected instrument. */
  constructor(
    minCh: number = MIN_MEMBER,
    maxCh: number = MAX_MEMBER,
    reuse: 'lifo' | 'fifo' = 'lifo',
    exclude: number[] = [],
  ) {
    this.minCh = minCh;
    this.maxCh = maxCh;
    this.fifo = reuse === 'fifo';
    this.exclude = new Set(exclude);
    this.reset();
  }

  reset(): void {
    this.inUse.clear();
    this.order = [];
    this.free = [];
    for (let ch = this.maxCh; ch >= this.minCh; ch--) {
      if (!this.exclude.has(ch)) this.free.push(ch);
    }
  }

  /** Returns the channel assigned to `key`. If `evicted` is non-null, the
   *  caller must emit a note-off for the evicted key on the returned channel
   *  before its new note-on. */
  acquire(key: KeyId): { channel: number; evicted: KeyId | null } {
    const existing = this.inUse.get(key);
    if (existing !== undefined) return { channel: existing, evicted: null };
    if (this.free.length > 0) {
      /* FIFO: take the oldest-freed channel (front); LIFO: most-recent (back).
         `reset` seeds the list maxCh..minCh, so FIFO hands out high channels
         first — order is irrelevant, only the reuse recency matters. */
      const ch = this.fifo ? this.free.shift()! : this.free.pop()!;
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

  /** Debug snapshot of internal state (channel assignments, free list, age
   *  order). Read-only copies. Used by piano-out diagnostics. */
  debugState(): { inUse: Array<[KeyId, number]>; free: number[]; order: KeyId[] } {
    return { inUse: [...this.inUse.entries()], free: [...this.free], order: [...this.order] };
  }
}
