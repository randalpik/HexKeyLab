#!/usr/bin/env python3
"""trim.py - cut an OBS recording (HKL overlay) into a loop-ready mp4.

Loop semantics
  The start is the first onset of the chosen take (or an explicit time).
  --end is the loop DOWNBEAT in source time: the moment the first onset
  should recur when the player loops. The decay is truncated there with a
  short declick ramp (default 5 ms, raised-cosine). Loop period = end - onset.

Typical session
  trim.py session.mkv out.mp4 --list                 # takes in the file
  trim.py session.mkv out.mp4 --take -1 --onsets     # onsets of the last take
  trim.py session.mkv out.mp4 --end 446.20 --preview # audition the seam
  trim.py session.mkv out.mp4 --end 446.20           # encode

--end forms: absolute seconds (446.20), +D = onset + D (loop length),
             last+D / last-D = D after/before the last detected onset.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile


def die(msg, code=1):
    print(f"trim: {msg}", file=sys.stderr)
    sys.exit(code)


def run(cmd, capture=True):
    r = subprocess.run(cmd, stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.PIPE if capture else None, text=True)
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()[-8:] if capture else []
        die("command failed: " + " ".join(cmd) + ("\n  " + "\n  ".join(tail) if tail else ""))
    return r


def probe_duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path])
    return float(r.stdout.strip())


def probe_fps(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=r_frame_rate", "-of", "default=nw=1:nk=1", path])
    num, _, den = r.stdout.strip().partition("/")
    return float(num) / float(den or 1)


def detect_segments(path, track, noise_db, gap, min_take):
    """Sound segments [(onset, end)] separated by silences >= gap seconds."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-vn", "-i", path,
                        "-map", f"0:a:{track}",
                        "-af", f"silencedetect=n={noise_db}dB:d={gap}",
                        "-f", "null", "-"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        die("silencedetect failed:\n" + r.stderr.strip().splitlines()[-1])
    events = [(m.group(1), float(m.group(2)))
              for m in re.finditer(r"silence_(start|end): ([0-9.]+)", r.stderr)]
    total = probe_duration(path)
    segs, cur = [], 0.0
    for kind, t in events:
        if kind == "start":
            if t - cur >= min_take:
                segs.append((cur, t))
        else:
            cur = t
    if total - cur >= min_take:
        segs.append((cur, total))
    return segs


def print_segments(segs):
    print(f"{'take':>4}  {'onset':>9}  {'end':>9}  {'len':>7}")
    for i, (a, b) in enumerate(segs, 1):
        print(f"{i:>4}  {a:9.3f}  {b:9.3f}  {b - a:7.3f}")


def extract_wav(src, track, start, length, out):
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.6f}", "-t", f"{length:.6f}", "-i", src,
         "-map", f"0:a:{track}", "-vn", "-ar", "48000", "-c:a", "pcm_s16le", out])


def aubio_onsets(wav, threshold):
    if not shutil.which("aubioonset"):
        die("aubioonset not found (pacman -S aubio)")
    r = run(["aubioonset", "-i", wav, "-t", str(threshold)])
    return [float(x) for x in r.stdout.split()]


def fade_filter(L, fi, fo, curve, tail_silence=0.0):
    """Declick ramps; afade t=out holds gain 0 after the ramp, which is the tail silence."""
    parts = []
    if fi > 0:
        parts.append(f"afade=t=in:st=0:d={fi:.6f}:curve={curve}")
    if fo > 0 or tail_silence > 0:
        parts.append(f"afade=t=out:st={L - tail_silence - fo:.6f}:d={max(fo, 1e-4):.6f}:curve={curve}")
    return ",".join(parts) or "anull"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--list", action="store_true", help="print the take table and exit")
    ap.add_argument("--onsets", action="store_true", help="print aubio onsets for the take and exit")
    ap.add_argument("--take", type=int, default=-1, help="take index from --list (negative = from end; default -1)")
    ap.add_argument("--start", default="auto", help="'auto' = first onset of the take, or absolute seconds")
    ap.add_argument("--end", help="loop downbeat: T, +D (after onset), last+D / last-D (after/before last onset)")
    ap.add_argument("--pre", type=float, default=0.025, help="silent pre-roll before the onset, taken from the tail so the loop period is unchanged (default 0.025 = one AAC/Opus frame of player slop)")
    ap.add_argument("--fade-in", type=float, default=0.005, help="declick ramp at start, seconds (default 0.005)")
    ap.add_argument("--fade-out", type=float, default=0.005, help="declick ramp at end, seconds (default 0.005)")
    ap.add_argument("--no-snap", action="store_true", help="do not snap the loop period to the video frame grid")
    ap.add_argument("--tail-silence", type=float, default=0.0, help="digital zero after the fade-out, for players that flush the tail at the loop seek (default 0)")
    ap.add_argument("--curve", default="hsin", help="afade curve (hsin, tri, qsin, exp...; default hsin)")
    ap.add_argument("--audio-track", type=int, default=0)
    ap.add_argument("--noise", type=float, default=-60.0, help="silence threshold dBFS (default -60)")
    ap.add_argument("--gap", type=float, default=1.0, help="min silence between takes, seconds (default 1.0)")
    ap.add_argument("--min-take", type=float, default=1.0, help="ignore sound segments shorter than this")
    ap.add_argument("--onset-threshold", type=float, default=0.3, help="aubioonset -t (default 0.3)")
    ap.add_argument("--preview", action="store_true", help="render the audio seam looped and play it; no video encode")
    ap.add_argument("--no-play", action="store_true", help="with --preview: write the wavs but do not play")
    ap.add_argument("--seam", type=float, default=1.0, help="seconds of tail and head in the preview (default 1.0)")
    ap.add_argument("--loops", type=int, default=4, help="preview repetitions (default 4)")
    ap.add_argument("--crf", type=int, default=18)
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--abr", default="256k", help="AAC bitrate (default 256k)")
    ap.add_argument("--workdir", help="where preview/analysis wavs go (default: temp dir)")
    a = ap.parse_args()

    if not os.path.isfile(a.src):
        die(f"no such file: {a.src}")
    total = probe_duration(a.src)
    workdir = a.workdir or os.path.join(tempfile.gettempdir(), "obs-trim",
                                        os.path.splitext(os.path.basename(a.src))[0])
    os.makedirs(workdir, exist_ok=True)

    # --- start / take -------------------------------------------------------
    segs = detect_segments(a.src, a.audio_track, a.noise, a.gap, a.min_take)
    if a.list:
        print_segments(segs)
        return
    if a.start == "auto":
        if not segs:
            die("no sound found above the noise threshold")
        try:
            seg = segs[a.take - 1 if a.take > 0 else a.take]
        except IndexError:
            print_segments(segs)
            die(f"--take {a.take} out of range")
        onset, seg_end = seg
    else:
        onset = float(a.start)
        seg_end = next((b for (s, b) in segs if s <= onset < b), total)
    print(f"onset {onset:.3f}  (take ends {seg_end:.3f}, silence-to-silence length {seg_end - onset:.3f})")

    # --- onsets (aubio) ------------------------------------------------------
    need_onsets = a.onsets or (a.end or "").startswith("last")
    onsets = []
    if need_onsets:
        take_wav = os.path.join(workdir, "take.wav")
        extract_wav(a.src, a.audio_track, onset, seg_end - onset, take_wav)
        onsets = aubio_onsets(take_wav, a.onset_threshold)
        if a.onsets:
            print(f"{'#':>3}  {'rel':>8}  {'abs':>9}  {'dprev':>7}")
            prev = None
            for i, t in enumerate(onsets, 1):
                d = "" if prev is None else f"{t - prev:7.3f}"
                print(f"{i:>3}  {t:8.3f}  {onset + t:9.3f}  {d:>7}")
                prev = t
            if onsets:
                print(f"last onset at {onset + onsets[-1]:.3f} (rel {onsets[-1]:.3f})")
            return
        if not onsets:
            die("aubio found no onsets in the take")

    # --- end -----------------------------------------------------------------
    if not a.end:
        die("--end is required (or use --list / --onsets)")
    e = a.end.strip()
    if e.startswith("last"):
        m = re.fullmatch(r"last([+-][0-9.]+)?", e)
        if not m:
            die(f"bad --end: {e}")
        end = onset + onsets[-1] + (float(m.group(1)) if m.group(1) else 0.0)
    elif e.startswith("+"):
        end = onset + float(e[1:])
    else:
        end = float(e)
    L = end - onset
    snap_note = ""
    if not a.no_snap:
        fps = probe_fps(a.src)
        Ls = round(L * fps) / fps
        snap_note = f"  (requested {L:.4f}, snapped to {fps:g} fps grid: {Ls - L:+.4f})"
        L, end = Ls, onset + Ls
    if L <= a.fade_out + a.fade_in + a.tail_silence + a.pre:
        die(f"loop length {L:.3f}s too short")
    if end > total:
        die(f"--end {end:.3f} is past the file end {total:.3f}")
    cut_start = max(0.0, onset - a.pre)
    af = fade_filter(L, a.fade_in, a.fade_out, a.curve, a.tail_silence)
    print(f"end   {end:.3f}  loop period {L:.4f}s{snap_note}")
    print(f"cut   [{cut_start:.3f}, {cut_start + L:.3f}]  pre-roll {a.pre * 1000:.0f} ms  fade in/out "
          f"{a.fade_in * 1000:.0f}/{a.fade_out * 1000:.0f} ms ({a.curve})  tail silence {a.tail_silence * 1000:.0f} ms")

    # --- preview -------------------------------------------------------------
    if a.preview:
        clip = os.path.join(workdir, "clip.wav")
        seam = os.path.join(workdir, "seam.wav")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-ss", f"{cut_start:.6f}", "-t", f"{L:.6f}", "-i", a.src,
             "-map", f"0:a:{a.audio_track}", "-vn", "-ar", "48000",
             "-af", af, "-c:a", "pcm_s16le", clip])
        S = min(a.seam, L / 2)
        size = int(round(2 * S * 48000))
        fc = (f"[0:a]atrim=start={L - S:.6f},asetpts=PTS-STARTPTS[t];"
              f"[0:a]atrim=end={S:.6f},asetpts=PTS-STARTPTS[h];"
              f"[t][h]concat=n=2:v=0:a=1,aloop=loop={a.loops - 1}:size={size}")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", clip,
             "-filter_complex", fc, "-c:a", "pcm_s16le", seam])
        print(f"preview: {seam}  (tail {S:.2f}s + head {S:.2f}s, x{a.loops}); full clip: {clip}")
        if not a.no_play:
            subprocess.run(["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", seam])
        return

    # --- encode --------------------------------------------------------------
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-stats",
         "-ss", f"{cut_start:.6f}", "-t", f"{L:.6f}", "-i", a.src,
         "-map", "0:v:0", "-map", f"0:a:{a.audio_track}",
         "-vf", "setpts=PTS-STARTPTS", "-fps_mode", "cfr",
         "-af", af,
         "-c:v", "libx264", "-preset", a.preset, "-crf", str(a.crf), "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", a.abr,
         "-movflags", "+faststart", a.out], capture=False)
    print(f"wrote {a.out}  ({probe_duration(a.out):.3f}s)")


if __name__ == "__main__":
    main()
