// AudioWorkletProcessor for lossless capture. Runs on the audio render thread
// and sees every 128-frame render quantum. When capturing, it posts a COPY of
// each channel's quantum to the main thread (transferring the buffers, so no
// re-encode and no GC pressure on the audio thread). Always posts a cheap
// per-quantum RMS scalar while active, so the Connect-step meter and the
// recorder's silence detector have a live level without shipping full frames.
//
// MediaRecorder was rejected (opus/webm only → lossy) and ScriptProcessorNode
// is deprecated + main-thread (drops frames under GC). See docs/lessons.md
// "lossless intermediate before the analyzer".
//
// Control messages (main → worklet): { capture: boolean } | { meter: boolean }.
// Data messages (worklet → main): { rms: number, ch?: Float32Array[] }.

// Minimal ambient types for the AudioWorkletGlobalScope (not in the DOM lib).
// `declare class` means the binding exists at runtime (it's a global in the
// worklet scope) — extending it emits a real `extends AudioWorkletProcessor`.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private capturing = false;
  private metering = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { capture?: boolean; meter?: boolean };
      if (typeof d.capture === 'boolean') this.capturing = d.capture;
      if (typeof d.meter === 'boolean') this.metering = d.meter;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    if (!this.capturing && !this.metering) return true;

    // Per-quantum RMS over the first channel (cheap; enough for meter + silence).
    const ch0 = input[0];
    let sumSq = 0;
    for (let i = 0; i < ch0.length; i++) sumSq += ch0[i] * ch0[i];
    const rms = Math.sqrt(sumSq / ch0.length);

    if (this.capturing) {
      // Copy each channel's quantum and transfer the buffers to the main thread.
      const ch: Float32Array[] = [];
      const transfer: ArrayBuffer[] = [];
      for (let c = 0; c < input.length; c++) {
        const copy = input[c].slice();
        ch.push(copy);
        transfer.push(copy.buffer);
      }
      this.port.postMessage({ rms, ch }, transfer);
    } else {
      this.port.postMessage({ rms });
    }
    return true;
  }
}

registerProcessor('hkl-capture', CaptureProcessor);
