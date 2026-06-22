// Build a tiny mono 16-bit PCM WAV in memory — no network, no asset files.
// Used to feed the engine real, decodable audio bytes through its
// `instrumentProvider` hook so the smoke exercises the true decode → buffer →
// voice → loop path against a real AudioContext.
export function synthSineWav(freq = 220, durSec = 0.5, sampleRate = 44100): Uint8Array {
  const n = Math.floor(durSec * sampleRate);
  const dataLen = n * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const wr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // 0.25 amplitude with a short raised-cosine fade in/out to avoid edge clicks.
    const env = Math.min(1, i / 200, (n - i) / 200);
    const a = Math.sin(2 * Math.PI * freq * t) * 0.25 * env;
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, a)) * 32767, true);
  }
  return new Uint8Array(buf);
}
