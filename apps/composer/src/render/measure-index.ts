// Measure index for the virtualized ribbon renderer.
//
// Tracks each measure's width and x-position along the horizontal ribbon. Widths
// start as an ESTIMATE and are replaced with the real (measured) width once that
// measure's chunk has been rendered — so the renderer never needs an O(total)
// up-front layout pass (standard virtualization with estimated sizes). x-
// positions are cumulative; a width change reflows the suffix.
//
// Pure data structure (no DOM, no Verovio) — unit-testable.

export class MeasureIndex {
  readonly ids: string[];
  private widths: number[];
  private measured: boolean[];
  private prefix: number[] | null = null;   // cumulative x; lazily rebuilt
  private estimate: number;

  constructor(ids: string[], estimate = 400) {
    this.ids = ids.slice();
    this.estimate = estimate;
    this.widths = ids.map(() => estimate);
    this.measured = ids.map(() => false);
  }

  get count(): number { return this.ids.length; }

  private ensurePrefix(): number[] {
    if (this.prefix) return this.prefix;
    const p = new Array<number>(this.ids.length + 1);
    p[0] = 0;
    for (let i = 0; i < this.ids.length; i++) p[i + 1] = p[i] + this.widths[i];
    this.prefix = p;
    return p;
  }

  /** Left x of measure `i` (px). */
  xOf(i: number): number { return this.ensurePrefix()[Math.max(0, Math.min(i, this.ids.length))]; }
  widthOf(i: number): number { return this.widths[i] ?? this.estimate; }
  isMeasured(i: number): boolean { return this.measured[i] ?? false; }
  get totalWidth(): number { return this.ensurePrefix()[this.ids.length]; }

  /** Record a measured width. Returns true if it changed (→ suffix reflowed). */
  setMeasured(i: number, width: number): boolean {
    if (i < 0 || i >= this.widths.length) return false;
    const changed = !this.measured[i] || Math.abs(this.widths[i] - width) > 0.01;
    this.widths[i] = width;
    this.measured[i] = true;
    if (changed) this.prefix = null;   // invalidate cumulative sums
    return changed;
  }

  /** Set many measured widths (a chunk's worth). Returns true if any changed. */
  setMeasuredMany(entries: Array<{ id: string; width: number }>): boolean {
    let changed = false;
    let i = 0;
    const idIndex = this.idIndexMap();
    for (const e of entries) {
      const idx = idIndex.get(e.id);
      if (idx === undefined) continue;
      if (this.setMeasured(idx, e.width)) changed = true;
      i++;
    }
    void i;
    return changed;
  }

  private _idIndex: Map<string, number> | null = null;
  private idIndexMap(): Map<string, number> {
    if (this._idIndex) return this._idIndex;
    const m = new Map<string, number>();
    this.ids.forEach((id, i) => m.set(id, i));
    this._idIndex = m;
    return m;
  }

  indexOfId(id: string): number { return this.idIndexMap().get(id) ?? -1; }

  /** Measure index whose span contains x (clamped to [0, count-1]). */
  measureAtX(x: number): number {
    const p = this.ensurePrefix();
    if (x <= 0) return 0;
    if (x >= p[this.ids.length]) return this.ids.length - 1;
    // binary search for the last prefix <= x
    let lo = 0, hi = this.ids.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid + 1] <= x) lo = mid + 1; else hi = mid; }
    return Math.min(lo, this.ids.length - 1);
  }

  /** Inclusive measure-index range intersecting [left, right] (viewport, px). */
  rangeForViewport(left: number, right: number): { lo: number; hi: number } {
    return { lo: this.measureAtX(left), hi: this.measureAtX(right) };
  }
}
