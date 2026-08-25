// Step/kink click detector for the in-flight crossfade-cut repro
// (handoff/hkle-inflight-crossfade-cut.md). Pure Node, no deps.
//
// Defect class: a mid-crossfade stop(0) removes the incoming source's
// contribution instantaneously — a single-sample step in the mix whose size is
// (voice vol × fade progress × instantaneous source sample), followed by the
// old source's 5ms restore ramp. Detection: single-sample outliers in the
// SECOND difference (a step of size S spikes d2 by ~S while smooth musical
// content is suppressed by (2πf/fs)² — ~5× better step separation than the
// first difference on harmonic material), thresholded against a block-local
// ROBUST scale (median |d2| of the two NEIGHBORING 5ms blocks — the defect
// can't inflate its own threshold, and note onsets sit next to a signal-level
// block so their smooth 4ms attack ramps don't flag).
//
// The detector is only trusted after validateDetector(): synthetic cuts of the
// same shape (instant multiplicative dip, 5ms linear recovery) injected into a
// clean capture must be caught at 100% for depth ≥ MIN_VALIDATED_DEPTH with
// zero false positives on the untouched capture. This is the analyze_seams.py
// lesson from the handoff: a detector not validated against the defect class
// proves nothing by silence.
//
// CLI: node test/ramp-stress/detect.mjs out/<scenario>.wav out/<scenario>.events.json

import { readFileSync } from 'node:fs';

// ── WAV (float32 mono) ────────────────────────────────────────────────────
export function writeWavFloat32(pcm, sampleRate) {
  const dataLen = pcm.length * 4;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);            // IEEE float
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLen).copy(buf, 44);
  return buf;
}

export function readWavFloat32(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a WAV`);
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data chunk`);
  if (fmt.tag !== 3 || fmt.bits !== 32 || fmt.channels !== 1) {
    throw new Error(`${path}: expected mono float32 WAV (got tag ${fmt.tag}, ${fmt.bits}-bit, ${fmt.channels}ch)`);
  }
  const pcm = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
  return { pcm: pcm.slice(0), sampleRate: fmt.rate };
}

// ── detector ──────────────────────────────────────────────────────────────
export const DETECT_DEFAULTS = {
  K: 10,            // outlier ratio vs block-local median |d2|
  ABS_FLOOR: 3e-4,  // ignore spikes below ~-70dBFS (silence-region noise)
  BLOCK_MS: 5,
  MERGE_MS: 2,      // flags within this window collapse into one defect
  /* Impulsiveness: a real cut puts ±S on TWO adjacent d2 samples, far above
     the surrounding music; smooth curvature that merely crosses K× the block
     median (seen in quiet release tails) is spatially uniform. Require the
     flagged |d2| to exceed IMPULSE× the neighborhood max (±3..±20 samples,
     the ±2 core excluded so the defect can't gate itself). */
  IMPULSE: 3,
};

export function detectDefects(pcm, sampleRate, opts = {}) {
  const { K, ABS_FLOOR, BLOCK_MS, MERGE_MS } = { ...DETECT_DEFAULTS, ...opts };
  const n = pcm.length;
  if (n < 4) return [];
  const B = Math.round((BLOCK_MS / 1000) * sampleRate);
  const d2At = (i) => pcm[i + 1] - 2 * pcm[i] + pcm[i - 1]; // i in [1, n-2]
  const nBlocks = Math.ceil((n - 2) / B);

  // Per-block median |second difference|.
  const med = new Float64Array(nBlocks);
  const scratch = new Float64Array(B);
  for (let b = 0; b < nBlocks; b++) {
    const s = 1 + b * B, e = Math.min(s + B, n - 1);
    let m = 0;
    for (let i = s; i < e; i++) scratch[m++] = Math.abs(d2At(i));
    const sl = scratch.subarray(0, m);
    sl.sort();
    med[b] = m ? sl[m >> 1] : 0;
  }

  // Threshold each sample against its NEIGHBOR blocks (never its own),
  // then require local impulsiveness (see DETECT_DEFAULTS.IMPULSE).
  const { IMPULSE } = { ...DETECT_DEFAULTS, ...opts };
  const flags = [];
  for (let i = 1; i < n - 1; i++) {
    const d = Math.abs(d2At(i));
    if (d < ABS_FLOOR) continue;
    const b = Math.floor((i - 1) / B);
    const scale = Math.max(b > 0 ? med[b - 1] : 0, b < nBlocks - 1 ? med[b + 1] : 0, ABS_FLOOR / K);
    if (d <= K * scale) continue;
    let hood = 0;
    for (let j = Math.max(1, i - 20); j <= Math.min(n - 2, i + 20); j++) {
      if (Math.abs(j - i) <= 2) continue;
      const a = Math.abs(d2At(j));
      if (a > hood) hood = a;
    }
    if (d > IMPULSE * hood) flags.push({ sample: i, mag: d, ratio: d / scale });
  }

  // Merge nearby flags into single defects (keep the peak).
  const mergeGap = Math.round((MERGE_MS / 1000) * sampleRate);
  const defects = [];
  for (const f of flags) {
    const last = defects[defects.length - 1];
    if (last && f.sample - last.sample <= mergeGap) {
      if (f.mag > last.mag) { last.sample = f.sample; last.mag = f.mag; last.ratio = f.ratio; }
    } else {
      defects.push({ ...f });
    }
  }
  return defects;
}

// ── synthetic injection (detector validation) ─────────────────────────────
export const MIN_VALIDATED_DEPTH = 0.2;

/* Inject the defect shape at `sample`: instantaneous multiplicative dip of
   `depth`, recovering linearly over 5ms — the same envelope the bug produces
   (incoming contribution vanishes at the cut; old source restored over 5ms). */
export function injectCut(pcm, sampleRate, sample, depth) {
  const R = Math.round(0.005 * sampleRate);
  for (let j = 0; j < R && sample + j < pcm.length; j++) {
    pcm[sample + j] *= 1 - depth * (1 - j / R);
  }
}

/* Pick injection points on signal-bearing content, at local |x| maxima so a
   depth-d cut produces a step of ~d×(local peak) — the defect's own
   best-audibility case. Real defects land at arbitrary phase; validation
   establishes the detector catches the class when it is catchable. */
export function pickInjectionPoints(pcm, sampleRate, count) {
  const B = Math.round(0.05 * sampleRate); // 50ms regions
  const regions = [];
  for (let s = B; s + B < pcm.length - B; s += B) {
    let peak = 0, peakAt = s;
    for (let i = s; i < s + B; i++) {
      const a = Math.abs(pcm[i]);
      if (a > peak) { peak = a; peakAt = i; }
    }
    if (peak > 0.02) regions.push({ at: peakAt, peak });
  }
  if (regions.length < count) return regions.map((r) => r.at);
  const stride = Math.floor(regions.length / count);
  return Array.from({ length: count }, (_, k) => regions[k * stride].at);
}

/* Gate: zero false positives on the clean capture, 100% detection of injected
   cuts at every depth ≥ MIN_VALIDATED_DEPTH. Reports per-depth hit rates for
   the shallower depths too (informational — small Cause-2 cuts live there). */
export function validateDetector(cleanPcm, sampleRate, opts = {}) {
  const depths = [0.05, 0.1, 0.2, 0.4, 0.7];
  const perDepth = [];
  const falsePositives = detectDefects(cleanPcm, sampleRate, opts);
  const points = pickInjectionPoints(cleanPcm, sampleRate, 12);
  const tolerance = Math.round(0.002 * sampleRate);
  for (const depth of depths) {
    const injected = cleanPcm.slice(0);
    for (const p of points) injectCut(injected, sampleRate, p, depth);
    const found = detectDefects(injected, sampleRate, opts);
    let hits = 0;
    for (const p of points) {
      if (found.some((d) => Math.abs(d.sample - p) <= tolerance)) hits++;
    }
    perDepth.push({ depth, hits, of: points.length });
  }
  const gated = perDepth.filter((r) => r.depth >= MIN_VALIDATED_DEPTH);
  const ok = falsePositives.length === 0 && gated.every((r) => r.hits === r.of);
  return { ok, falsePositives: falsePositives.length, perDepth, nPoints: points.length };
}

// ── correlation with the event log ────────────────────────────────────────
/* Match each defect against the instrumented call log. A cancel is inferred
   from any call made with a pendingSwitch present; it is "in-window" when the
   call's clock read sat inside [switchTime − 4ms, switchTime + xfDur + 5ms]
   (the −4ms guard band is the Cause-2 race: a JS read just below switchTime
   while the render thread has already started the fade). Expected signature:
   every defect within a few ms of an in-window cancel; zero elsewhere.

   Flags coinciding with scheduled note ONSETS are classified 'onset' and kept
   out of the defect counts: the 4ms linear attack's slope corner is a real
   (tiny, by-design) kink in the output — vol/(0.004·fs) ≈ 0.003 at vol ≈ 0.55
   — not the defect class under investigation. */
export function correlate(defects, events, startFrame, sampleRate) {
  const CANCEL_CALLS = new Set(['sNoteOff', 'sRampFreq', 'sNoteOnFaded', 'sHardStop']);
  const cancels = events.filter((e) => CANCEL_CALLS.has(e.call) && e.pre && e.pre.pendingSwitch);
  // Onset times: sNoteOn's startAt is args[3], sNoteOnFaded's atTime is
  // args[4] (post-voiceKey positions — repro.js records args after the key);
  // both fall back to the call's own clock read when unscheduled.
  const onsets = events
    .filter((e) => e.call === 'sNoteOn' || e.call === 'sNoteOnFaded')
    .map((e) => ({ key: e.key, at: (e.call === 'sNoteOn' ? e.args?.[3] : e.args?.[4]) ?? e.t }));
  const rows = defects.map((d) => {
    const t = (startFrame + d.sample) / sampleRate;
    let best = null;
    for (const ev of cancels) {
      const dt = t - ev.t;
      if (dt < -0.002 || dt > 0.006) continue;
      if (!best || Math.abs(dt) < Math.abs(best.dt)) {
        const ps = ev.pre.pendingSwitch;
        best = {
          dt, call: ev.call, key: ev.key,
          offsetIntoFade: (ev.t - ps.switchTime) / ps.xfDur,
          inWindow: ev.t >= ps.switchTime - 0.004 && ev.t <= ps.switchTime + ps.xfDur + 0.005,
        };
      }
    }
    // Window: sNoteOn starts its source ≥5ms after the call (pre-start pan
    // anchor), then the 4ms attack — both corners land within ~20ms.
    const onset = !best && onsets.find((o) => t >= o.at - 0.002 && t <= o.at + 0.020);
    return { t, sample: d.sample, mag: d.mag, ratio: d.ratio, match: best, onset: onset ? onset.key : null };
  });
  return {
    rows,
    nDefects: rows.filter((r) => !r.onset).length,
    nOnsets: rows.filter((r) => r.onset).length,
    nCorrelatedInWindow: rows.filter((r) => r.match && r.match.inWindow).length,
    nCorrelatedOutOfWindow: rows.filter((r) => r.match && !r.match.inWindow).length,
    nUncorrelated: rows.filter((r) => !r.match && !r.onset).length,
  };
}

// ── seam-dip stats ────────────────────────────────────────────────────────
/* The splice-class measure the step detector is blind to (energy
   redistribution): per wrap-seam commit, RMS of the 30ms fade window vs the
   mean of its ±flanking windows. A validated, on-time fade sits near 1.0
   (strings.hki clean floor ≈ 0.807); a fade deferred past its validated wrap
   splices mismatched phase and dips to 0.5–0.7. Compare a scenario's floor
   against the clean capture's. Seams in release tails (pre-RMS < 0.01) are
   skipped — the ratio is meaningless there. */
export function seamDipStats(pcm, events, startFrame, sampleRate) {
  const rms = (a, b) => {
    a = Math.max(0, Math.round(a)); b = Math.min(pcm.length, Math.round(b));
    let s = 0;
    for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const dips = [];
  let deferred = 0;
  for (const e of events) {
    if (e.call !== 'seamCommit' || e.kind !== 'wrap') continue;
    if (e.deferredMs > 0) deferred++;
    const c = e.t * sampleRate - startFrame;
    if (c < sampleRate * 0.1 || c > pcm.length - sampleRate * 0.1) continue;
    const pre = rms(c - 0.045 * sampleRate, c - 0.015 * sampleRate);
    const fade = rms(c, c + 0.030 * sampleRate);
    const post = rms(c + 0.035 * sampleRate, c + 0.065 * sampleRate);
    if (pre < 0.01) continue;
    dips.push(fade / ((pre + post) / 2));
  }
  dips.sort((a, b) => a - b);
  const q = (p) => dips[Math.floor(p * (dips.length - 1))];
  return dips.length
    ? { n: dips.length, deferred, min: q(0), p10: q(0.1), median: q(0.5) }
    : { n: 0, deferred };
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [wavPath, eventsPath] = process.argv.slice(2);
  if (!wavPath) {
    console.error('usage: node detect.mjs <capture.wav> [<events.json>]');
    process.exit(2);
  }
  const { pcm, sampleRate } = readWavFloat32(wavPath);
  const defects = detectDefects(pcm, sampleRate);
  console.log(`${wavPath}: ${(pcm.length / sampleRate).toFixed(1)}s, ${defects.length} defect(s)`);
  if (eventsPath) {
    const meta = JSON.parse(readFileSync(eventsPath, 'utf8'));
    const c = correlate(defects, meta.events, meta.startFrame, sampleRate);
    for (const r of c.rows) {
      const m = r.match
        ? `${r.match.call} dt=${(r.match.dt * 1000).toFixed(2)}ms offset=${(r.match.offsetIntoFade * 100).toFixed(0)}% ${r.match.inWindow ? 'IN-WINDOW' : 'out-of-window'}`
        : r.onset ? `onset kink (${r.onset}, expected)` : 'UNCORRELATED';
      console.log(`  t=${r.t.toFixed(4)}s mag=${r.mag.toFixed(4)} ratio=${r.ratio.toFixed(1)} → ${m}`);
    }
    console.log(`in-window ${c.nCorrelatedInWindow} / out-of-window ${c.nCorrelatedOutOfWindow} / uncorrelated ${c.nUncorrelated} / onset ${c.nOnsets}`);
  } else {
    for (const d of defects.slice(0, 40)) {
      console.log(`  sample=${d.sample} t=${(d.sample / sampleRate).toFixed(4)}s mag=${d.mag.toFixed(4)} ratio=${d.ratio.toFixed(1)}`);
    }
  }
}
