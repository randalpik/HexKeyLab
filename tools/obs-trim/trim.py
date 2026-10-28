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
    print(f"{'take':>4}  {'onset':>9}  {'end':>9}  {'len':>7}  {'gap before':>10}")
    prev_end = None
    for i, (a, b) in enumerate(segs, 1):
        gap = "" if prev_end is None else f"{a - prev_end:9.3f}s"
        print(f"{i:>4}  {a:9.3f}  {b:9.3f}  {b - a:7.3f}  {gap:>10}")
        prev_end = b


def select_take(segs, spec):
    """'all' -> first onset..last end; 'A-B' -> onset of A..end of B; 'N' (negative from end)."""
    spec = spec.strip().lower()
    if spec == "all":
        return 1, len(segs)
    if "-" in spec[1:]:
        a, b = spec.split("-", 1)
        a, b = int(a), int(b)
        a = a if a > 0 else len(segs) + 1 + a
        b = b if b > 0 else len(segs) + 1 + b
        return a, b
    n = int(spec)
    n = n if n > 0 else len(segs) + 1 + n
    return n, n


def extract_wav(src, track, start, length, out):
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.6f}", "-t", f"{length:.6f}", "-i", src,
         "-map", f"0:a:{track}", "-vn", "-ar", "48000", "-c:a", "pcm_s16le", out])


def aubio_onsets(wav, threshold):
    if not shutil.which("aubioonset"):
        die("aubioonset not found (pacman -S aubio)")
    r = run(["aubioonset", "-i", wav, "-t", str(threshold)])
    return [float(x) for x in r.stdout.split()]


# Lattice crops per OBS frame size, covering the WHOLE lattice. The overlay is opaque
# inside its outline and the area around it in both layouts is static (black band /
# dark backdrop), so the rectangle may extend past the outline: measured 2026-10-14,
# no cell outside the hexes changes in >0.1% of frames. ffmpeg crop order w:h:x:y.
LAYOUTS = {
    (1080, 1920): "1080:420:0:950",    # vertical: lattice band y 970-1350, full width
    (1920, 1080): "1900:520:10:560",   # horizontal: lattice parallelogram x 40-1880, y 580-1060
}


def probe_size(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height", "-of", "csv=p=0", path])
    w, h = r.stdout.strip().split(",")[:2]
    return int(w), int(h)


GAP_DEFAULT = 2.0  # s of digital silence that separates takes. Library (35 kept takes): the shortest
                   # setup pause before a legitimate take is 2.26 s (revolutionary take 20), the longest
                   # rest inside a kept take 0.62 s; in-piece fermatas longer than 2 s (rare) need --take A-B.
CELL = 24          # full-res px per tracking cell (a hex is ~60 px wide, so 2-3 cells)
CELL_THR = 10      # luma-level change of a cell mean that counts as an event (noise floor ~1-2)
FLASH_FRAMES = 6   # HKL paints a re-struck key unselected for KEY_FLASH_MS = 60 ms (3-4 frames at
                   # 60 fps; overlay paint cadence can add 1-2) before re-lighting it


def lattice_events(src, crop, t0, dur, workdir, thr=CELL_THR):
    """Per-hex key events from the lattice crop.

    The crop is reduced to a grid of CELL×CELL cells (mean luma each) so a hex
    spans a few cells. Per cell, a lightening is a key-down; a darkening that is
    re-lit within FLASH_FRAMES is HKL's re-strike flash (apps/hkl/src/render/
    key-flash.ts) and is a key-down at the DARKENING frame, the note-on; a
    darkening not re-lit in time is a key-up. Key-downs in one frame merge.
    Returns (downs [(t_abs, n_cells)], n_ups, noise = median per-frame max |dcell|)."""
    cw, ch, cx, cy = (int(v) for v in crop.split(":"))
    gw, gh = max(1, cw // CELL), max(1, ch // CELL)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{t0:.6f}", "-t", f"{dur:.6f}", "-i", src,
                        "-an", "-vf", f"crop={crop},scale={gw}:{gh}:flags=area,format=gray,showinfo",
                        "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=False)
    if r.returncode != 0:
        die("lattice decode failed:\n" + r.stderr.decode(errors="replace").strip().splitlines()[-1])
    times = [float(m.group(1)) + t0 for m in re.finditer(rb"pts_time:\s*([0-9.]+)", r.stderr)]
    n = gw * gh
    frames = [r.stdout[i * n:(i + 1) * n] for i in range(len(r.stdout) // n)]
    if len(frames) < 2:
        die("lattice decode produced no frames")
    if len(times) < len(frames):   # showinfo lines can go missing from a busy stderr: extrapolate
        step = (times[-1] - times[0]) / (len(times) - 1) if len(times) > 1 else 1 / 60
        base = times[-1] if times else t0
        times += [base + step * (i + 1) for i in range(len(frames) - len(times))]
    times = times[:len(frames)]
    pending = {}         # cell -> (frame, darkening magnitude) awaiting a flash re-light
    downs, ups, maxd = {}, 0, []
    for k in range(1, len(frames)):
        prev, cur = frames[k - 1], frames[k]
        md = 0
        for c in range(n):
            d = cur[c] - prev[c]
            ad = d if d >= 0 else -d
            if ad > md:
                md = ad
            pd = pending.get(c)
            if pd is not None and k - pd[0] > FLASH_FRAMES:
                ups += 1; pending.pop(c); pd = None
            if ad < thr:
                continue
            if d > 0:
                if pd is not None and d >= pd[1] // 2:     # re-light: the flash of a re-strike
                    downs[pd[0]] = downs.get(pd[0], 0) + 1; pending.pop(c)
                else:
                    downs[k] = downs.get(k, 0) + 1
            else:
                if pd is not None:
                    ups += 1
                pending[c] = (k, ad)
        maxd.append(md)
    ups += len(pending)
    maxd.sort()
    noise = maxd[len(maxd) // 2] if maxd else 0
    return [(times[k], cnt) for k, cnt in sorted(downs.items())], ups, noise


class TakeAudio:
    """Mono PCM of one take (from extract_wav) + a local onset-rise probe.

    rise(t, lo, hi): over frames whose center lies in [t+lo, t+hi], the largest
    jump of the first-difference (high-pass) 10 ms RMS envelope above the floor of
    the previous 20 ms, in dB; the time of that jump; and the sustain = mean level
    over the 30 ms after the jump, above the same floor. A real attack rises by
    several dB even under a loud ringing decay (hammer transients are broadband)
    and holds that level, since a note has duration; a silent lattice change
    (hover, feather touch) shows ~1 dB of envelope noise, or a click that is gone
    within one frame (sustain ~0)."""
    HOP, WIN = 240, 480   # 5 ms hop, 10 ms window at 48 kHz

    def __init__(self, wav):
        import array
        import wave
        w = wave.open(wav)
        self.sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = array.array("h"); raw.frombytes(w.readframes(n)); w.close()
        self.ch, self.raw, self.n = ch, raw, n
        self.duration = n / self.sr

    def _mono(self, i0, i1):
        raw, ch = self.raw, self.ch
        if ch == 1:
            return [raw[i] / 32768.0 for i in range(i0, i1)]
        return [(raw[2 * i] + raw[2 * i + 1]) / 65536.0 for i in range(i0, i1)]

    def rise(self, t, lo, hi):
        import math
        a = max(0, int((t + lo) * self.sr) - 6 * self.HOP)
        b = min(self.n, int((t + hi) * self.sr) + self.WIN + 8 * self.HOP)
        if b - a < self.WIN + 14 * self.HOP:
            return -99.0, t, 0.0
        x = self._mono(a, b)
        d = [x[i] - x[i - 1] for i in range(1, len(x))]
        L = []
        for k in range(0, len(d) - self.WIN, self.HOP):
            seg = d[k:k + self.WIN]
            # floor at -75 dBFS: digital silence -> AAC pre-echo (-85 dB) must not read as a rise
            L.append(max(-75.0, 10 * math.log10(sum(v * v for v in seg) / self.WIN + 1e-14)))
        best, best_k = -99.0, None
        for k in range(4, len(L) - 7):
            tc = (a + k * self.HOP + self.WIN / 2) / self.sr
            if tc < t + lo or tc > t + hi:
                continue
            j = L[k] - min(L[k - 4:k])
            if j > best:
                best, best_k = j, k
        if best_k is None:
            return -99.0, t, 0.0
        floor = min(L[best_k - 4:best_k])
        sustain = sum(L[best_k + 1:best_k + 7]) / 6 - floor
        return best, (a + best_k * self.HOP) / self.sr, sustain


# Physical video->audio lag range (overlay leads the captured audio; the publisher's
# render tick adds 0-60 ms of jitter per event) and the onset-rise gates.
LAG_LO, LAG_HI = 0.02, 0.14
LAST_LO, LAST_HI = 0.0, 0.17   # last event: nothing follows, so widen - but never look before the key-down
RISE_DB = 2.5          # a real attack in the high-passed envelope; silent lattice changes sit ~1 dB
SUSTAIN_DB = 2.0       # ...and holds for 30 ms (library: real last notes >= 3.3 dB, ghosts <= 0.6 dB)
TAIL_SOUND = 0.15      # a real last note keeps sounding at least this long after its attack


def video_onsets(src, audio_track, crop, onset, seg_end, workdir, thr=CELL_THR, segs=None):
    """Onsets of one take: WHICH events from the lattice video, WHEN from the audio.
    Each lattice key-down is refined to the attack rise in [t+LAG_LO, t+LAG_HI] when
    no other key-down is within 150 ms; crowded events take t + the take's median
    lag. Trailing events with no rise and no sustained sound after them are silent
    lattice changes (a hover or a feather touch after the piece) and are dropped.
    Returns (absolute onset times, info dict)."""
    t0 = max(0.0, onset - 0.5)
    downs, ups, noise = lattice_events(src, crop, t0, seg_end - t0, workdir, thr)
    if not downs:
        die(f"no key-down seen in the lattice crop (noise {noise} luma levels)")
    take_wav = os.path.join(workdir, "take.wav")
    extract_wav(src, audio_track, t0, seg_end - t0, take_wav)
    au = TakeAudio(take_wav)
    vt = [t - t0 for t, _ in downs]                      # lattice times, take-relative
    # sound boundaries inside the window, for the trailing-ghost test
    silences = []
    if segs:
        for i in range(len(segs) - 1):
            silences.append((segs[i][1] - t0, segs[i + 1][0] - t0))
        silences.append((segs[-1][1] - t0, 1e9))

    def sound_after(t):
        for a, b in silences:
            if a > t:
                return a - t
            if a <= t < b:
                return 0.0
        return 1e9

    # drop trailing ghosts
    while len(vt) > 1:
        r, _, sus = au.rise(vt[-1], LAST_LO, LAST_HI)   # the low-level decay tail wiggles +-3 dB: never look before the key-down
        if (r >= RISE_DB and sus >= SUSTAIN_DB) or sound_after(vt[-1] + LAG_HI) >= TAIL_SOUND:
            break
        vt.pop()
    refined, offsets = [], []
    for i, t in enumerate(vt):
        isolated = (i == 0 or t - vt[i - 1] > 0.15) and (i == len(vt) - 1 or vt[i + 1] - t > 0.15)
        if i == len(vt) - 1:
            r, tr, _ = au.rise(t, LAST_LO, LAST_HI)
        elif isolated:
            r, tr, _ = au.rise(t, LAG_LO, LAG_HI)
        else:
            r, tr = -99.0, None
        if tr is not None and r >= RISE_DB:
            refined.append(tr); offsets.append(tr - t)
        else:
            refined.append(None)
    offsets.sort()
    lag = offsets[len(offsets) // 2] if offsets else 0.08
    q = (lambda f: offsets[int(len(offsets) * f)]) if offsets else (lambda f: lag)
    out = [t0 + (tr if tr is not None else t + lag) for t, tr in zip(vt, refined)]
    if refined and refined[-1] is not None:   # lag-shifted chord-mates may not trail the audio-timed last attack
        out = [min(o, out[-1]) for o in out[:-1]] + [out[-1]]
    return out, dict(downs=len(downs), kept=len(vt), ups=ups, noise=noise, lag=lag, matched=len(offsets),
                     lag_p25=q(0.25), lag_p75=q(0.75))


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
    ap.add_argument("--onsets", action="store_true", help="print the take's onsets (from the lattice video) and exit")
    ap.add_argument("--audio-onsets", action="store_true", help="use aubio on the audio instead of the lattice video")
    ap.add_argument("--lattice", help="crop W:H:X:Y fully inside the lattice outline (default: preset by frame size)")
    ap.add_argument("--cell-thr", type=int, default=CELL_THR, help="luma-level change of a lattice cell that counts as a key event (default 10; noise ~1-2)")
    ap.add_argument("--crop-png", help="write the lattice crop of one frame here, to check --lattice")
    ap.add_argument("--take", default="-1", help="take from --list: N (negative = from end; default -1), a range A-B, or 'all' — "
                    "a rest of >--gap seconds of digital silence inside one piece shows up as two takes")
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
    ap.add_argument("--gap", type=float, default=GAP_DEFAULT, help=f"min silence between takes, seconds (default {GAP_DEFAULT}; a legitimate take has followed 2.26 s)")
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
            lo, hi = select_take(segs, a.take)
            if not (1 <= lo <= hi <= len(segs)):
                raise IndexError
        except (IndexError, ValueError):
            print_segments(segs)
            die(f"--take {a.take} out of range (1..{len(segs)}, A-B, or all)")
        onset, seg_end = segs[lo - 1][0], segs[hi - 1][1]
        if lo > 1 and segs[lo - 1][0] - segs[lo - 2][1] < 3.0:
            print(f"note: take {lo} starts {segs[lo - 1][0] - segs[lo - 2][1]:.1f}s after take {lo - 1} ends — "
                  f"a rest inside one piece? use --take {lo - 1}-{hi} (or --take all)")
        if hi < len(segs) and segs[hi][0] - segs[hi - 1][1] < 3.0:
            print(f"note: take {hi + 1} starts {segs[hi][0] - segs[hi - 1][1]:.1f}s after take {hi} ends — "
                  f"a rest inside one piece? use --take {lo}-{hi + 1} (or --take all)")
    else:
        onset = float(a.start)
        seg_end = next((b for (s, b) in segs if s <= onset < b), total)
    print(f"onset {onset:.3f}  (take ends {seg_end:.3f}, silence-to-silence length {seg_end - onset:.3f})")

    # --- onsets --------------------------------------------------------------
    need_onsets = a.onsets or (a.end or "").startswith("last")
    onsets = []  # absolute source times, audio-aligned
    # A >1 s digital-silence rest splits a piece into two "takes"; an explicit end past the
    # take boundary extends the analysis window to it.
    e = (a.end or "").strip()
    if e and not e.startswith("last"):
        seg_end = max(seg_end, onset + float(e[1:]) if e.startswith("+") else float(e))
    if need_onsets:
        if a.audio_onsets:
            take_wav = os.path.join(workdir, "take.wav")
            extract_wav(a.src, a.audio_track, onset, seg_end - onset, take_wav)
            onsets = [onset + t for t in aubio_onsets(take_wav, a.onset_threshold)]
            print(f"audio onsets (aubio): {len(onsets)}")
        else:
            crop = a.lattice or LAYOUTS.get(probe_size(a.src))
            if not crop:
                die("no lattice preset for this frame size; pass --lattice W:H:X:Y (a rect inside the lattice outline)")
            if a.crop_png:
                run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{onset + 1.0:.3f}",
                     "-i", a.src, "-frames:v", "1", "-vf", f"crop={crop}", a.crop_png])
                print(f"wrote {a.crop_png}")
            onsets, info = video_onsets(a.src, a.audio_track, crop, onset, seg_end, workdir, a.cell_thr, segs)
            if info["noise"] > 4:
                print(f"warning: lattice crop noise {info['noise']} luma levels — it probably includes camera; check --crop-png")
            print(f"video onsets: crop {crop}, {info['downs']} key-down frames ({info['downs'] - info['kept']} trailing ghosts dropped) / "
                  f"{info['ups']} key-up bursts, noise {info['noise']} levels; audio-refined {info['matched']} events, "
                  f"video->audio lag {info['lag'] * 1000:+.0f} ms (p25 {info['lag_p25'] * 1000:+.0f}, p75 {info['lag_p75'] * 1000:+.0f})")
        if a.onsets:
            print(f"{'#':>3}  {'rel':>8}  {'abs':>9}  {'dprev':>7}")
            prev = None
            for i, t in enumerate(onsets, 1):
                d = "" if prev is None else f"{t - prev:7.3f}"
                print(f"{i:>3}  {t - onset:8.3f}  {t:9.3f}  {d:>7}")
                prev = t
            if onsets:
                print(f"last onset at {onsets[-1]:.3f} (rel {onsets[-1] - onset:.3f})")
            return
        if not onsets:
            die("no onsets found in the take")

    # --- end -----------------------------------------------------------------
    if not a.end:
        die("--end is required (or use --list / --onsets)")
    e = a.end.strip()
    if e.startswith("last"):
        m = re.fullmatch(r"last([+-][0-9.]+)?", e)
        if not m:
            die(f"bad --end: {e}")
        end = onsets[-1] + (float(m.group(1)) if m.group(1) else 0.0)
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
