#!/usr/bin/env python3
"""validate.py - check trim.py's onset detection against hand-cut mp4s.

For every <lib>/<name>.mp4 with a matching <obs>/<name>.mkv: locate the take by
correlating the mp4's audio head and tail against the mkv, map the mp4's end into
source time, and compare it with the last detected onset. A correct detector puts
the last onset a little BEFORE the cut: delta = cut - last_onset >= 0 and small.

  validate.py [--obs ~/Videos/obs] [--lib ~/Videos/Lumatone] [--only name ...]
"""
import argparse
import glob
import os
import subprocess
import sys
import tempfile

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")   # BLAS thread pools thrash on the many small dots here
os.environ.setdefault("OMP_NUM_THREADS", "1")
import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trim  # noqa: E402

SR = 48000


def pcm(path, start, dur):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.6f}", "-t", f"{dur:.6f}",
                        "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def best_lag(needle, hay):
    """Normalised cross-correlation of needle over hay (FFT) -> (score, offset_samples)."""
    m, n = len(needle), len(hay)
    if n < m or not np.any(needle):
        return 0.0, 0
    size = 1 << (n + m - 1).bit_length()
    c = np.fft.irfft(np.fft.rfft(hay, size) * np.conj(np.fft.rfft(needle, size)), size)[: n - m + 1]
    cs = np.concatenate(([0.0], np.cumsum(hay.astype(np.float64) ** 2)))
    nn = float(np.linalg.norm(needle))
    win = np.sqrt(np.maximum(cs[m:] - cs[: n - m + 1], 0.0)) * nn
    win = np.maximum(win, 0.05 * nn * nn)   # a near-silent hay window scores ~0, never blows up
    i = int(np.argmax(c / win))
    return float(c[i] / win[i]), i


def analyze(name, obs, lib, workdir, debug=False):
    mkv = os.path.join(obs, name + ".mkv")
    mp4 = os.path.join(lib, name + ".mp4")
    mp4_dur = trim.probe_duration(mp4)
    segs = trim.detect_segments(mkv, 0, -60.0, trim.GAP_DEFAULT, 1.0)
    head = pcm(mp4, 0.0, 1.0)
    tail = pcm(mp4, max(0.0, mp4_dur - 1.1), 1.0)
    best = None
    for i, (on, off) in enumerate(segs, 1):
        if off - on < 2.0:
            continue
        h0 = max(0.0, on - 1.0)                      # allow up to 1 s of hand-cut pre-roll
        hs, hi = best_lag(head, pcm(mkv, h0, 2.5))
        start_src = h0 + hi / SR
        end_src = start_src + mp4_dur
        ts, ti = best_lag(tail, pcm(mkv, max(0.0, end_src - 1.1 - 0.3), 1.6))
        score = hs + 0.5 * ts                          # the head picks the take; the tail confirms the cut
        if best is None or score > best[0]:
            best = (score, i, on, off, start_src, end_src, hs, ts)
    if best is None:
        print(f"{name:<18}  no candidate take"); return
    score, ti, on, off, start_src, cut, hs, ts = best
    crop = trim.LAYOUTS.get(trim.probe_size(mkv))
    wd = os.path.join(workdir, name); os.makedirs(wd, exist_ok=True)
    # A >1 s digital-silence rest splits a piece into two "takes": analyse up to the cut regardless.
    win_end = max(off, cut + 1.0)
    onsets, info = trim.video_onsets(mkv, 0, crop, on, win_end, wd, trim.CELL_THR, segs)
    lag, noise, last_vid = info["lag"], info["noise"], onsets[-1]
    t0 = max(0.0, on - 0.5)
    aub = trim.aubio_onsets(os.path.join(wd, "take.wav"), 0.3)   # written by video_onsets from t0
    last_aub = t0 + aub[-1] if aub else float("nan")
    d_vid, d_aub = cut - last_vid, cut - last_aub
    note = []
    if hs < 0.8: note.append(f"weak match h{hs:.2f} t{ts:.2f}")   # a silent mp4 tail scores 0 by design
    if noise > 4: note.append(f"noisy crop {noise} levels")
    if d_vid < 0: note.append("ONSET AFTER CUT")
    if d_vid > 5: note.append("last onset far before cut")
    print(f"{name:<18} {ti:>4} {lag*1000:>+6.0f} {info['downs']:>5} {last_vid:>9.3f} {last_aub:>9.3f} {cut:>9.3f} {d_vid:>7.3f} {d_aub:>7.3f}  {'; '.join(note)}", flush=True)
    if debug:
        print(f"    {info['downs']} key-downs, {info['downs'] - info['kept']} trailing ghosts dropped, "
              f"{info['matched']} audio-refined, lag {lag*1000:+.0f} ms (p25 {info['lag_p25']*1000:+.0f}, p75 {info['lag_p75']*1000:+.0f})")
        print(f"    last onsets:       " + " ".join(f"{t:.3f}" for t in onsets[-6:]))
        print(f"    last aubio onsets: " + " ".join(f"{t0 + t:.3f}" for t in aub[-4:]))
        print(f"    cut {cut:.3f}  (mp4 start {start_src:.3f}, take {on:.3f}-{off:.3f}, window to {win_end:.3f})", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--obs", default=os.path.expanduser("~/Videos/obs"))
    ap.add_argument("--lib", default=os.path.expanduser("~/Videos/Lumatone"))
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--debug", action="store_true", help="print offset clusters and the last events per file")
    ap.add_argument("--workdir", default=os.path.join(tempfile.gettempdir(), "obs-trim", "validate"))
    a = ap.parse_args()
    os.makedirs(a.workdir, exist_ok=True)
    names = sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(a.lib, "*.mp4")))
    if a.only:
        names = [n for n in names if n in a.only]
    print(f"{'name':<18} {'take':>4} {'lag':>6} {'downs':>5} {'last_vid':>9} {'last_aub':>9} {'cut':>9} {'d_vid':>7} {'d_aub':>7}  note")
    for name in names:
        if not os.path.isfile(os.path.join(a.obs, name + ".mkv")):
            continue
        try:
            analyze(name, a.obs, a.lib, a.workdir, a.debug)
        except SystemExit as e:
            print(f"{name:<18}  error: {e}", flush=True)


if __name__ == "__main__":
    main()
