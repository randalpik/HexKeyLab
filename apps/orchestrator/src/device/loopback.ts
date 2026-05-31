// Synthetic loopback device — a CaptureDevice with no hardware. A note-on spins
// up a small additive-synth tone (fundamental + harmonics) with an exponential
// decay, routed through the SAME CaptureGraph the real input uses, so discovery,
// capture, gates, and analysis can run end-to-end with zero hardware.
//
// With `velocityVaries` (default) velocity shapes level AND timbre, with a
// deliberate brightness JUMP above velocity 64 — so discovery can be verified to
// find a bin boundary near 64. Set it false for a fully velocity-INVARIANT tone
// (every velocity sounds identical), exercising the "no discrete layers → even
// bins" fallback. See Phase C verification in the plan.

import { CaptureGraph } from './captureGraph.js';
import { midiToFreq } from './device.js';
import type { CaptureDevice, CaptureRecord } from './types.js';

interface Voice { oscs: OscillatorNode[]; env: GainNode; }

export class LoopbackDevice implements CaptureDevice {
  private ctx: AudioContext;
  private mix: GainNode;
  private graph!: CaptureGraph;
  private voices = new Map<number, Voice>();
  /** When false, the tone is fully velocity-invariant (level + timbre fixed) →
   *  discovery finds no boundaries and falls back to even bins. When true,
   *  velocity drives level + a brightness jump above 64. */
  velocityVaries = true;
  /** Back-compat alias for tests/UI written against the old name. */
  get brightnessJump(): boolean { return this.velocityVaries; }
  set brightnessJump(v: boolean) { this.velocityVaries = v; }

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.mix = ctx.createGain();
    this.mix.gain.value = 1;
  }

  static async create(): Promise<LoopbackDevice> {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    await CaptureGraph.addModule(ctx);
    const dev = new LoopbackDevice(ctx);
    dev.graph = new CaptureGraph(ctx, dev.mix);
    return dev;
  }

  get sampleRate(): number { return this.ctx.sampleRate; }

  noteOn(note: number, velocity: number): void {
    this.noteOff(note);
    const now = this.ctx.currentTime;
    const f0 = midiToFreq(note);

    // Discrete velocity LAYERS — exactly what a velocity-layered sampler does and
    // what discovery is built to find: the timbre/level are FLAT within a layer
    // and JUMP between layers (boundaries at 43 and 85 → 3 layers). When velocity
    // is invariant, pin to the middle layer so every probe is identical (the
    // even-bin fallback fixture). A dense 1/n^(1/tilt) harmonic series keeps the
    // spectrum stable across identical-velocity captures.
    let peak: number, tilt: number;
    if (!this.velocityVaries) {
      peak = 0.25; tilt = 1.3;
    } else {
      const layer = velocity <= 43 ? 0 : velocity <= 85 ? 1 : 2;
      [peak, tilt] = [[0.10, 0.8], [0.25, 1.3], [0.45, 2.2]][layer] as [number, number];
    }

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + 0.005);   // 5ms attack
    env.gain.setTargetAtTime(0.0001, now + 0.005, 0.45);         // natural decay (~2-2.5s to silence)
    env.connect(this.mix);

    const harmonics: Array<[number, number]> = [];
    let ampSum = 0;
    for (let n = 1; n <= 10; n++) {
      const amp = Math.pow(n, -1 / tilt);        // 1/n^(1/tilt): brighter as tilt grows
      if (amp > 0.01) { harmonics.push([n, amp]); ampSum += amp; }
    }
    // Normalize so the in-phase harmonic sum peaks at the envelope level (not
    // above it) — keeps captures below 0 dBFS so they pass the clip gate.
    for (const h of harmonics) h[1] /= ampSum;
    const oscs: OscillatorNode[] = [];
    for (const [mult, amp] of harmonics) {
      if (amp <= 0) continue;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f0 * mult;
      const g = this.ctx.createGain();
      g.gain.value = amp;
      osc.connect(g); g.connect(env);
      osc.start(now);
      oscs.push(osc);
    }
    this.voices.set(note, { oscs, env });
  }

  noteOff(note: number): void {
    const voice = this.voices.get(note);
    if (!voice) return;
    const now = this.ctx.currentTime;
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setTargetAtTime(0.0001, now, 0.08);   // key release
    for (const o of voice.oscs) { try { o.stop(now + 0.6); } catch { /* ignore */ } }
    this.voices.delete(note);
  }

  allNotesOff(): void {
    for (const note of [...this.voices.keys()]) this.noteOff(note);
  }

  arm(): void { this.graph.arm(); }
  take(): CaptureRecord { return this.graph.take(); }
  trailingRms(windowSec?: number): number { return this.graph.trailingRms(windowSec); }
  setMeter(on: boolean): void { this.graph.setMeter(on); }
  onLevel(cb: (rms: number) => void): () => void { return this.graph.onLevel(cb); }

  teardown(): void {
    this.allNotesOff();
    try { this.graph.teardown(); } catch { /* ignore */ }
    try { this.mix.disconnect(); } catch { /* ignore */ }
    try { void this.ctx.close(); } catch { /* ignore */ }
    this.voices.clear();
  }
}
