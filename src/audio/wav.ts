// Minimal WAV encoder. Takes per-channel Float32 PCM and emits a 44-byte
// RIFF/WAVE/fmt /data header followed by interleaved 16-bit little-endian PCM.
//
// Used by the audio-capture path (src/audio/capture.ts) to materialize the
// accumulated AudioWorklet output as a downloadable blob. Standalone so it's
// reusable if an offline-render path is added later.

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/* Float32 [-1, 1] → Int16. Clamp first so samples that overshoot (limiter
   release, denormals) don't wrap around the modular Int16 conversion. */
function floatToInt16(f: number): number {
  const c = f < -1 ? -1 : f > 1 ? 1 : f;
  return c < 0 ? Math.round(c * 32768) : Math.round(c * 32767);
}

export function encodeWav16(channels: Float32Array[], sampleRate: number): Blob {
  const numCh = channels.length;
  if (numCh === 0) throw new Error('encodeWav16: no channels');
  const frames = channels[0].length;
  for (let c = 1; c < numCh; c++) {
    if (channels[c].length !== frames) throw new Error('encodeWav16: channel length mismatch');
  }
  const bytesPerSample = 2;
  const dataBytes = frames * numCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);              // subchunk1 size (PCM)
  view.setUint16(20, 1, true);               // audio format = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPerSample, true); // byte rate
  view.setUint16(32, numCh * bytesPerSample, true);              // block align
  view.setUint16(34, 16, true);              // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      view.setInt16(offset, floatToInt16(channels[c][i]), true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
