// AudioWorkletProcessor that copies stereo input frames back to the main
// thread via MessagePort. Connected as a parallel sink off the master limiter
// in src/audio/capture.ts; output is unused.
//
// Plain .js (not .ts) so Vite can emit it as a stand-alone asset that
// AudioContext.audioWorklet.addModule() can fetch — TypeScript files would
// either get inlined as raw source (invalid JS) or rejected by the worklet
// module loader on MIME grounds.

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    /* Stereo expected; if upstream feeds mono, duplicate it so the WAV is
       always stereo and downstream code doesn't have to branch. */
    const L = input[0] ? input[0].slice() : new Float32Array(128);
    const R = input.length > 1 && input[1] ? input[1].slice() : L.slice();
    this.port.postMessage({ L, R }, [L.buffer, R.buffer]);
    return true;
  }
}

registerProcessor('hkl-capture', CaptureProcessor);
