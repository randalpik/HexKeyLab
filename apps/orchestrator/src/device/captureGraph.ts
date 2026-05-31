// The capture half of a device, shared by the real audio input and the
// synthetic loopback: a 'hkl-capture' AudioWorkletNode fed by some source node,
// concatenating Float32 quanta while capturing and tracking a trailing RMS for
// the meter + silence detection. The owner supplies the AudioContext + source.

import workletUrl from './capture-worklet.ts?worker&url';
import type { CaptureRecord } from './types.js';

interface RmsSample { t: number; ms: number; }

export class CaptureGraph {
  private node: AudioWorkletNode;
  private sink: GainNode;
  private capturing = false;
  private chunks: Float32Array[][] = [];
  private nChannels = 0;
  private recentRms: RmsSample[] = [];
  private levelListeners = new Set<(rms: number) => void>();

  /** Load the capture worklet onto `ctx`. Call once per context before `new`. */
  static addModule(ctx: AudioContext): Promise<void> {
    return ctx.audioWorklet.addModule(workletUrl);
  }

  constructor(private ctx: AudioContext, source: AudioNode) {
    this.node = new AudioWorkletNode(ctx, 'hkl-capture');
    // Pull the node through a muted gain so its process() is scheduled even
    // though it produces silence (a node with no path to destination may be
    // suspended by the graph).
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent) => this.onFrame(e.data as { rms: number; ch?: Float32Array[] });
  }

  private onFrame(d: { rms: number; ch?: Float32Array[] }): void {
    const t = this.ctx.currentTime;
    this.recentRms.push({ t, ms: d.rms * d.rms });
    const cutoff = t - 1.0;
    while (this.recentRms.length && this.recentRms[0].t < cutoff) this.recentRms.shift();
    for (const fn of this.levelListeners) { try { fn(d.rms); } catch { /* ignore */ } }
    if (this.capturing && d.ch) {
      if (this.nChannels === 0) { this.nChannels = d.ch.length; this.chunks = d.ch.map(() => []); }
      for (let c = 0; c < this.nChannels; c++) this.chunks[c].push(d.ch[c]);
    }
  }

  get sampleRate(): number { return this.ctx.sampleRate; }

  setMeter(on: boolean): void { this.node.port.postMessage({ meter: on }); }

  onLevel(cb: (rms: number) => void): () => void {
    this.levelListeners.add(cb);
    return () => this.levelListeners.delete(cb);
  }

  trailingRms(windowSec = 0.05): number {
    if (this.recentRms.length === 0) return 0;
    const cutoff = this.ctx.currentTime - windowSec;
    let sum = 0, n = 0;
    for (let i = this.recentRms.length - 1; i >= 0; i--) {
      if (this.recentRms[i].t < cutoff) break;
      sum += this.recentRms[i].ms; n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
  }

  arm(): void {
    this.chunks = [];
    this.nChannels = 0;
    this.capturing = true;
    this.node.port.postMessage({ capture: true });
  }

  take(): CaptureRecord {
    this.capturing = false;
    this.node.port.postMessage({ capture: false });
    const sampleRate = this.ctx.sampleRate;
    if (this.nChannels === 0) return { channels: [new Float32Array(0)], sampleRate };
    const channels: Float32Array[] = [];
    for (let c = 0; c < this.nChannels; c++) {
      let total = 0;
      for (const q of this.chunks[c]) total += q.length;
      const out = new Float32Array(total);
      let off = 0;
      for (const q of this.chunks[c]) { out.set(q, off); off += q.length; }
      channels.push(out);
    }
    this.chunks = [];
    this.nChannels = 0;
    return { channels, sampleRate };
  }

  teardown(): void {
    try { this.node.disconnect(); } catch { /* ignore */ }
    try { this.sink.disconnect(); } catch { /* ignore */ }
    this.levelListeners.clear();
  }
}
