// Audio input: getUserMedia → AudioContext → CaptureGraph (capture worklet).
//
// All browser DSP (echo cancellation, noise suppression, auto gain) is forced
// OFF — they would corrupt the loudness measurements and spectra the analyzer
// and discovery rely on. The capture/RMS mechanics live in CaptureGraph, shared
// with the synthetic loopback device.

import { CaptureGraph } from './captureGraph.js';
import type { CaptureRecord } from './types.js';

export interface AudioInputDevice { deviceId: string; label: string; }

/** Enumerate audio input devices. Labels are only populated once the user has
 *  granted mic permission, so callers typically list after a first start(). */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(d => d.kind === 'audioinput')
    .map(d => ({ deviceId: d.deviceId, label: d.label || '(unnamed input)' }));
}

export class AudioInput {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private graph: CaptureGraph | null = null;

  get sampleRate(): number { return this.ctx ? this.ctx.sampleRate : 48000; }
  get ready(): boolean { return this.graph != null; }

  async start(deviceId?: string): Promise<void> {
    if (this.graph) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
      video: false,
    });
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await CaptureGraph.addModule(this.ctx);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.graph = new CaptureGraph(this.ctx, this.source);
  }

  private g(): CaptureGraph {
    if (!this.graph) throw new Error('AudioInput not started');
    return this.graph;
  }

  setMeter(on: boolean): void { this.graph?.setMeter(on); }
  onLevel(cb: (rms: number) => void): () => void { return this.g().onLevel(cb); }
  trailingRms(windowSec?: number): number { return this.graph ? this.graph.trailingRms(windowSec) : 0; }
  arm(): void { this.g().arm(); }
  take(): CaptureRecord { return this.g().take(); }

  teardown(): void {
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.graph?.teardown(); } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.source = null; this.graph = null; this.stream = null; this.ctx = null;
  }
}
