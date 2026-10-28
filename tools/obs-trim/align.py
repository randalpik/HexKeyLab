#!/usr/bin/env python3
"""align.py - per-note performance data from HKL overlay videos and their scores.

Every <lib>/<name>.mp4 that has a <lib>/<name>.hkc is a performance of that
score as written (plus, sometimes, a pickup-length section repeated at the end
to close the last bar). The score supplies which notes exist and where they sit
in beats; the video's lattice supplies when each key went down. Output is one
JSON file: per video a manifest (file, title, composer, duration, time/key
signatures) and every note (lattice coords, name + octave, onset in seconds,
onset in beats, duration in beats; ties merged into one note).

  align.py                       # whole library -> --out
  align.py furelise tetris       # selected titles
  align.py --score-only          # score parse + self-checks, no video

Beats follow hkl:beat-groups when the score sets it (3/8 with "3" is one beat
per bar, 7/8 "3+4" has two unequal beats); otherwise compound meters (6/8,
9/8, 12/8...) beat in dotted units and everything else in the meter's unit.
Beat 0 is the first downbeat, so a pickup is negative. *_quarters fields give
the same positions in quarter notes.
"""
import argparse
import bisect
import json
import math
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from fractions import Fraction

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trim  # noqa: E402  (TakeAudio, extract_wav, LAYOUTS, lag gates)

MEI = "{http://www.music-encoding.org/ns/mei}"
HKL = "{https://hexkeylab.com/ns/mei}"
XMLID = "{http://www.w3.org/XML/1998/namespace}id"


# ---------------------------------------------------------------- naming (port of @hkl/shared/notes.ts)

LETTER_SEMI = {"A": 0, "B": 2, "C": 3, "D": 5, "E": 7, "F": 8, "G": 10}


def _acc(v):
    return "#" * v if v > 0 else "b" * -v


def fifth_name(r):
    if r >= 0:
        return "AEBFCGD"[r % 7], r // 7 + (1 if r % 7 >= 3 else 0)
    rr = -r
    return "ADGCFBE"[rr % 7], -(rr // 7 + (1 if rr % 7 >= 5 else 0))


def _third(letter, acc, up):
    L = "ABCDEFG"
    i = L.index(letter)
    if up:
        nl = L[(i + 2) % 7]
        return nl, 4 - (LETTER_SEMI[nl] - LETTER_SEMI[letter]) % 12 + acc
    nl = L[(i - 2) % 7]
    return nl, -(4 - (LETTER_SEMI[letter] - LETTER_SEMI[nl]) % 12) + acc


def coord_name(q, r):
    """(letter, accidental value, octave) of lattice key (q, r); A3 = (0, 0)."""
    letter, acc = fifth_name(r)
    pos = (q + 1) % 3
    if pos != 1:
        letter, acc = _third(letter, acc, pos == 2)
    octave = (57 + 4 * q + 7 * r - acc) // 12 - 1   # octave by letter, ignoring accidentals
    return letter, acc, octave


def coord_label(q, r):
    letter, acc, octave = coord_name(q, r)
    return f"{letter}{_acc(acc)}{octave}"


MEI_ACC = {"s": 1, "f": -1, "ss": 2, "x": 2, "ff": -2, "n": 0, "ts": 3, "tf": -3}


def key_name(fifths, mode):
    """Tonic of a key signature: fifths above C for major, above A for minor."""
    letter, acc = fifth_name(fifths if mode == "minor" else fifths - 3)
    return f"{letter}{_acc(acc)} {mode}" if mode else None


# ---------------------------------------------------------------- score

def _dur(el):
    d = el.get("dur")
    if d is None:
        return None
    v = Fraction(1, int(d))
    dots = int(el.get("dots", 0))
    return v * (2 - Fraction(1, 2 ** dots))


class Meter:
    def __init__(self, count, unit, groups=None, sym=None):
        self.count, self.unit, self.sym = count, unit, sym
        if groups:
            g = [int(x) for x in groups.split("+")]
        elif count % 3 == 0 and count > 3 and unit >= 8:
            g = [3] * (count // 3)
        else:
            g = [1] * count
        self.groups = g                                  # beat lengths in meter units
        self.length = Fraction(count, unit)              # whole notes per bar

    def label(self):
        return f"{self.count}/{self.unit}"

    def beat_at(self, x):
        """Beats from the barline at bar position x (whole notes)."""
        u = x * self.unit
        s = 0
        for i, g in enumerate(self.groups):
            if u < s + g:
                return i + (u - s) / g
            s += g
        return len(self.groups) + (u - s) / self.groups[-1]

    def describe(self):
        """beat_groups: the length of each beat in units of the meter's denominator."""
        return dict(sig=self.label(), symbol=self.sym, beats_per_bar=len(self.groups), beat_groups=self.groups)


def parse_hkc(path):
    """Notes (ties merged) and manifest fields of one .hkc.

    Each note: q, r, name, staff, id, and onset/end both in beats and quarter
    notes from the first downbeat. Raises on structure it cannot time."""
    root = ET.parse(path).getroot()
    title = root.findtext(f".//{MEI}titleStmt/{MEI}title") or ""
    composer = ""
    for p in root.iter(f"{MEI}persName"):
        if p.get("role") == "composer":
            composer = (p.text or "").strip()
    score = root.find(f".//{MEI}score")
    checks = []

    meter = key = None
    time_sigs, key_sigs, tempos = [], [], []
    raw = []                     # [abs_whole, end_whole, onset_beat, end_beat, note_el, staff, measure n]
    t_abs = Fraction(0)          # whole notes from the start of the first measure
    beat0 = Fraction(0)          # beats from the first downbeat at the current barline
    pickup_len = pickup_beats = Fraction(0)
    barlines = []               # beat of each barline from the first downbeat

    def apply_scoredef(sd, at_measure, at_beat):
        nonlocal meter, key
        if sd.get("meter.count"):
            meter = Meter(int(sd.get("meter.count")), int(sd.get("meter.unit")),
                          sd.get(f"{HKL}beat-groups"), sd.get("meter.sym"))
            time_sigs.append(dict(measure=at_measure, beat=at_beat, **meter.describe()))
        if sd.get("key.sig") is not None:
            ks = sd.get("key.sig")
            fifths = 0 if ks == "0" else int(ks[:-1]) * (1 if ks[-1] == "s" else -1)
            mode = sd.get("mode")
            key = (fifths, mode)
            key_sigs.append(dict(measure=at_measure, beat=at_beat, fifths=fifths, mode=mode,
                                 name=key_name(fifths, mode)))

    first_sd = score.find(f"{MEI}scoreDef")
    pending = [first_sd] if first_sd is not None else []
    section = score.find(f"{MEI}section")
    for el in section:
        tag = el.tag.replace(MEI, "")
        if tag == "scoreDef":
            pending.append(el)
            continue
        if tag != "measure":
            continue
        n = el.get("n")
        for sd in pending:
            apply_scoredef(sd, n, float(beat0))
        pending = []
        is_pickup = el.get("metcon") == "false" and n == "0"
        if el.get("metcon") == "false" and not is_pickup:
            raise ValueError(f"incomplete measure {n} that is not a pickup")
        for tp in el.iter(f"{MEI}tempo"):
            tempos.append(dict(measure=n, beat=float(beat0), mm=float(tp.get("mm")) if tp.get("mm") else None,
                               mm_unit=tp.get("mm.unit"), mm_dots=int(tp.get("mm.dots", 0)),
                               text=(tp.text or "").strip() or None))
        events, length = [], Fraction(0)
        for st in el.findall(f"{MEI}staff"):
            for ly in st.findall(f"{MEI}layer"):
                t = Fraction(0)

                def walk(node, scale):
                    nonlocal t
                    for c in node:
                        tg = c.tag.replace(MEI, "")
                        if tg in ("beam", "graceGrp"):
                            walk(c, scale)
                        elif tg == "tuplet":
                            walk(c, scale * Fraction(int(c.get("numbase")), int(c.get("num"))))
                        elif tg == "chord":
                            d = _dur(c) * scale
                            for nt in c.iter(f"{MEI}note"):
                                events.append((t, t + d, nt, int(st.get("n"))))
                            t += d
                        elif tg == "note":
                            if c.get("grace"):
                                raise ValueError("grace note")
                            d = _dur(c) * scale
                            events.append((t, t + d, c, int(st.get("n"))))
                            t += d
                        elif tg in ("rest", "space"):
                            t += _dur(c) * scale
                        elif tg in ("mRest", "mSpace", "multiRest", "mRpt", "beatRpt", "bTrem", "fTrem"):
                            raise ValueError(f"unhandled <{tg}>")
                walk(ly, Fraction(1))
                length = max(length, t)
        if is_pickup:
            pickup_len = length
            shift = meter.length - length
            to_beat = lambda x: meter.beat_at(shift + x) - len(meter.groups)  # noqa: E731
            pickup_beats = -to_beat(Fraction(0))
            ticks = el.get(f"{HKL}pickup-ticks")
            if ticks and Fraction(int(ticks), 64) != length:
                checks.append(f"pickup m0: layers {length} whole vs pickup-ticks {ticks}")
        else:
            if length != meter.length:
                checks.append(f"m{n}: content {length} whole vs meter {meter.label()}")
            b = beat0
            to_beat = lambda x, b=b: b + meter.beat_at(x)  # noqa: E731
        for s, e, nt, staff in events:
            raw.append([t_abs + s, t_abs + e, to_beat(s), to_beat(e), nt, staff, n])
        t_abs += length
        if not is_pickup:
            barlines.append(float(beat0))
            beat0 = beat0 + meter.beat_at(length)

    # merge ties: a note tied forward continues into the next note on the same key and staff
    # that starts exactly where it ends (data-tie-partner, when present, names it)
    by_id = {r_[4].get(XMLID): r_ for r_ in raw}
    starts = {}
    for r_ in raw:
        starts.setdefault((r_[0], r_[4].get("data-q"), r_[4].get("data-r"), r_[5]), []).append(r_)
    absorbed = set()
    notes = []
    for r_ in sorted(raw, key=lambda x: (x[0], x[5])):
        if id(r_) in absorbed:
            continue
        nt = r_[4]
        q, r = int(nt.get("data-q")), int(nt.get("data-r"))
        end_w, end_b, ids = r_[1], r_[3], [nt.get(XMLID)]
        cur = r_
        while "i" in (cur[4].get("tie") or "") or cur[4].get("tie") == "m":
            partner = by_id.get(cur[4].get("data-tie-partner"))
            if partner is None:
                cands = [c for c in starts.get((cur[1], cur[4].get("data-q"), cur[4].get("data-r"), cur[5]), [])
                         if (c[4].get("tie") or "") in ("m", "t")]
                partner = cands[0] if cands else None
            if partner is None or id(partner) in absorbed:
                checks.append(f"m{cur[6]}: tie from {cur[4].get(XMLID)} has no continuation")
                break
            absorbed.add(id(partner))
            cur = partner
            end_w, end_b = cur[1], cur[3]
            ids.append(cur[4].get(XMLID))
        if (nt.get("tie") or "") in ("m", "t") and len(ids) == 1:
            checks.append(f"m{r_[6]}: tie end {nt.get(XMLID)} with no start")
        mei_acc = MEI_ACC.get(nt.get("accid") or nt.get("accid.ges") or "n", None)
        notes.append(dict(q=q, r=r, staff=r_[5], measure=r_[6], ids=ids,
                          _w=r_[0], _we=end_w, onset_beats=r_[2], end_beats=end_b,
                          _mei=(nt.get("pname").upper(), mei_acc, int(nt.get("oct")))))

    # MEI pname/oct/accid and data-q/r are both the WRITTEN pitch, so they must agree
    mism = 0
    for nt in notes:
        letter, acc, octave = coord_name(nt["q"], nt["r"])
        p, a, o = nt["_mei"]
        if (p, o) != (letter, octave) or (a is not None and a != acc):
            mism += 1
            if mism <= 5:
                checks.append(f"m{nt['measure']} {nt['ids'][0]}: MEI {p}{a}{o} vs lattice {coord_label(nt['q'], nt['r'])}")
    if mism > 5:
        checks.append(f"... {mism} spelling mismatches in all")

    # An <octave> span shifts the notes of its staff whose onset tick lies in [data-hkl-t0, data-hkl-t1)
    # (64 ticks per whole note) by q +-3 per octave: Composer playback's rule (render/playback.ts
    # octaveQShift). Notes are reported at the key that sounds and is played.
    spans = []
    for ov in score.iter(f"{MEI}octave"):
        t0, t1 = ov.get("data-hkl-t0"), ov.get("data-hkl-t1")
        if t0 is None or t1 is None:
            checks.append(f"<octave> {ov.get(XMLID)} without a tick span")
            continue
        octaves = 2 if int(ov.get("dis", 8)) >= 15 else 1
        spans.append((float(t0), float(t1), int(ov.get("staff", 1)),
                      (-3 if ov.get("dis.place") == "below" else 3) * octaves))
    for nt in notes:
        tick = float(nt["_w"] * 64)
        shift = sum(s for t0, t1, st, s in spans if st == nt["staff"] and t0 - 1e-6 <= tick < t1 - 1e-6)
        if shift:
            nt["score_q"], nt["score_r"] = nt["q"], nt["r"]
            nt["q"] += shift
        nt["name"] = coord_label(nt["q"], nt["r"])
        nt["midi"] = 57 + 4 * nt["q"] + 7 * nt["r"]

    down = pickup_len
    for nt in notes:
        nt["onset_quarters"] = float((nt.pop("_w") - down) * 4)
        nt["dur_quarters"] = float((nt.pop("_we") - down) * 4) - nt["onset_quarters"]
        nt["dur_beats"] = float(nt["end_beats"] - nt["onset_beats"])
        nt["onset_beats"] = float(nt["onset_beats"])
        del nt["end_beats"], nt["_mei"]
    notes.sort(key=lambda x: (x["onset_beats"], x["midi"]))
    manifest = dict(title=title, composer=composer, time_signatures=time_sigs, key_signatures=key_sigs,
                    tempo_marks=tempos, pickup_beats=float(pickup_beats),
                    pickup_quarters=float(pickup_len * 4), measures=sum(1 for _ in section.iter(f"{MEI}measure")),
                    score_end_beats=float(beat0), score_end_quarters=float((t_abs - down) * 4),
                    barlines=barlines)
    return manifest, notes, checks


# ---------------------------------------------------------------- video

SCALE = 2            # analysis runs on the lattice crop at half resolution
BLOB_THR = 12        # luma rise between frames that marks a lighting pixel
DISK = 0.3           # sampling disk radius, in hex spacings
EDGE = 0.45          # a hex is sampled only if its center is this many spacings inside the crop


def video_info(path):
    r = trim.run(["ffprobe", "-v", "error", "-show_entries",
                  "stream=codec_type,nb_frames,r_frame_rate,duration,width,height", "-of", "json", path])
    info = dict(frames=None, fps=None, audio_duration_s=None)
    for s in json.loads(r.stdout)["streams"]:
        if s["codec_type"] == "video" and info["frames"] is None:
            num, den = (int(x) for x in s["r_frame_rate"].split("/"))
            info.update(frames=int(s["nb_frames"]), fps=Fraction(num, den), width=s["width"], height=s["height"])
        elif s["codec_type"] == "audio" and info["audio_duration_s"] is None:
            info["audio_duration_s"] = float(s["duration"])
    info["duration_s"] = float(info["frames"] / info["fps"])
    return info


def crop_frames(path, crop, pix="gray", chunk=256):
    """Lattice crop at 1/SCALE resolution as int16 arrays of up to `chunk` frames:
    [k, H, W] luma for pix="gray", [k, H, W, 3] for pix="rgb24"."""
    cw, ch, cx, cy = (int(v) for v in crop.split(":"))
    W, H = cw // SCALE, ch // SCALE
    nc = 3 if pix == "rgb24" else 1
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-an", "-vf",
                          f"crop={crop},scale={W}:{H}:flags=area,format={pix}", "-f", "rawvideo", "-pix_fmt", pix, "-"],
                         stdout=subprocess.PIPE)
    n = W * H * nc
    while True:
        buf = p.stdout.read(n * chunk)
        if not buf:
            break
        k = len(buf) // n
        a = np.frombuffer(buf[:k * n], np.uint8).astype(np.int16)
        yield a.reshape(k, H, W, 3) if nc == 3 else a.reshape(k, H, W)
    if p.wait() != 0:
        trim.die(f"ffmpeg decode failed: {path}")


def _components(mask):
    """4-connected components of a boolean image, as (ys, xs) arrays."""
    H, W = mask.shape
    seen = np.zeros(mask.shape, bool)
    out = []
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        seen[y0, x0] = True
        st, pts = [(y0, x0)], []
        while st:
            y, x = st.pop()
            pts.append((y, x))
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    st.append((yy, xx))
        out.append(np.array(pts))
    return out


def lighting_blobs(path, crop):
    """Centroids (full-res px in the crop) and areas of every region that lights up between frames."""
    blobs, prev = [], None
    for ch in crop_frames(path, crop):
        F = ch if prev is None else np.concatenate([prev[None], ch])
        for k in range(1, len(F)):
            m = (F[k] - F[k - 1]) >= BLOB_THR
            if m.sum() < 20:
                continue
            for p in _components(m):
                if len(p) >= 20:
                    blobs.append((p[:, 1].mean() * SCALE + SCALE / 2, p[:, 0].mean() * SCALE + SCALE / 2, len(p)))
        prev = F[-1]
    return np.array(blobs)


def _rot(a):
    return np.array([math.cos(a), math.sin(a)])


def fit_geometry(blobs, score_counts):
    """Pixel position of every lattice key: center(q, r) = O + q*uq + r*ur.

    The hex spacing and grid angle come from the offsets between single-hex
    blobs (q and r steps are both hex neighbors, 60 degrees apart). Which of
    the 12 neighbor assignments is (q, r), and the integer offset, are chosen
    by matching the blob positions against the score's key histogram."""
    area = np.median(blobs[:, 2])
    single = blobs[(blobs[:, 2] > 0.7 * area) & (blobs[:, 2] < 1.3 * area)][:, :2]
    if len(single) < 8:
        raise ValueError(f"only {len(single)} single-hex blobs")
    P = single[:600]
    d = (P[None] - P[:, None]).reshape(-1, 2)
    n = np.hypot(d[:, 0], d[:, 1])
    a0 = math.sqrt(area * SCALE * SCALE / (math.sqrt(3) / 2))     # flat-to-flat of a hex of that area
    nb = d[(n > 0.7 * a0) & (n < 1.15 * a0)]
    nn = np.hypot(nb[:, 0], nb[:, 1])
    a = float(np.median(nn))
    ang = np.arctan2(nb[:, 1], nb[:, 0]) * 6                     # mod 60 degrees -> full circle
    theta = math.atan2(np.sin(ang).mean(), np.cos(ang).mean()) / 6
    best = []
    for k in range(6):
        for hand in (1, -1):
            uq = a * _rot(theta + k * math.pi / 3)
            ur = a * _rot(theta + k * math.pi / 3 + hand * math.pi / 3)
            Minv = np.linalg.inv(np.column_stack([uq, ur]))
            f = single @ Minv.T
            ph = np.arctan2(np.sin(2 * math.pi * f).mean(0), np.cos(2 * math.pi * f).mean(0)) / (2 * math.pi)
            cells = np.round(f - ph).astype(int)
            resid = float(np.abs(f - ph - cells).max(1).mean())
            hist = {}
            for c in map(tuple, cells):
                hist[c] = hist.get(c, 0) + 1
            votes = {}
            for (bq, br), hb in hist.items():
                for (sq, sr), hs in score_counts.items():
                    o = (sq - bq, sr - br)
                    votes[o] = votes.get(o, 0) + min(hb, hs)
            for o, v in sorted(votes.items(), key=lambda x: -x[1])[:3]:
                hit = sum(hb for (bq, br), hb in hist.items() if (bq + o[0], br + o[1]) in score_counts)
                best.append((hit, v, k, hand, o, uq, ur, ph, resid))
    best.sort(key=lambda x: (-x[0], -x[1]))
    hit, v, k, hand, o, uq, ur, ph, resid = best[0]
    runner = best[1][0] if len(best) > 1 else 0
    O = np.column_stack([uq, ur]) @ (ph - np.array(o))     # blob f = cell + ph and (q, r) = cell + o
    return dict(O=O, uq=uq, ur=ur, spacing=a, angle_deg=math.degrees(theta), blob_hits=hit, blobs=len(single),
                runner_up_hits=runner, phase_resid=resid)


def center(geo, q, r):
    return geo["O"] + q * geo["uq"] + r * geo["ur"]


def sample_keys(path, crop, geo):
    """Whiteness of every lattice key inside the crop, per frame: min(R, G, B) of the mean
    color of a disk at the key's center. A lit key is its color blended toward white,
    which raises the weakest channel strongly for every hue (a pale-yellow key gains
    ~12 luma levels when lit, but its blue channel far more).
    Returns (keys [(q, r)], series float32 [frames, keys])."""
    cw, ch, cx, cy = (int(v) for v in crop.split(":"))
    W, H = cw // SCALE, ch // SCALE
    M = np.column_stack([geo["uq"], geo["ur"]])
    corners = np.array([[0, 0], [cw, 0], [0, ch], [cw, ch]], float) - geo["O"]
    f = corners @ np.linalg.inv(M).T
    lo, hi = np.floor(f.min(0)).astype(int) - 1, np.ceil(f.max(0)).astype(int) + 1
    a, rad = geo["spacing"], DISK * geo["spacing"] / SCALE
    yy, xx = np.mgrid[0:H, 0:W]
    keys, idx, offs = [], [], [0]
    for q in range(lo[0], hi[0] + 1):
        for r in range(lo[1], hi[1] + 1):
            x, y = center(geo, q, r)
            if not (EDGE * a <= x <= cw - EDGE * a and EDGE * a <= y <= ch - EDGE * a):
                continue
            x, y = (x - SCALE / 2) / SCALE, (y - SCALE / 2) / SCALE
            m = ((xx - x) ** 2 + (yy - y) ** 2) <= rad * rad
            keys.append((q, r))
            idx.append(np.flatnonzero(m))
            offs.append(offs[-1] + len(idx[-1]))
    idx = np.concatenate(idx)
    cnt = np.diff(offs).astype(np.float32)
    out = []
    for F in crop_frames(path, crop, "rgb24"):
        flat = F.reshape(len(F), -1, 3)[:, idx, :].astype(np.float32)
        out.append((np.add.reduceat(flat, offs[:-1], axis=1) / cnt[None, :, None]).min(axis=2))
    return keys, np.concatenate(out)


LIT_MIN = 30         # whiteness contrast below which a key never lit (played keys >= ~60, others <= ~18)
JUMP_MIN = 30        # ...and a lit key changes by at least this much between two frames (others <= ~12)
FLASH_FRAMES = trim.FLASH_FRAMES


def key_downs(series, fps):
    """Key-down frames of one key: an unlit->lit transition, or the darkening of HKL's
    re-strike flash (lit, unlit for <= FLASH_FRAMES, lit again), which is the note-on.
    A key already lit in frame 0 is a key-down at frame 0."""
    s = series
    lo, hi = float(np.percentile(s, 5)), float(s.max())
    if hi - lo < LIT_MIN or np.abs(np.diff(s)).max() < JUMP_MIN:
        return []
    on, off = lo + 0.6 * (hi - lo), lo + 0.4 * (hi - lo)       # hysteresis
    lit = bool(s[0] > on)
    downs, dark_at = ([0] if lit else []), None
    for k in range(1, len(s)):
        if not lit and s[k] > on:
            lit = True
            if dark_at is not None and k - dark_at <= FLASH_FRAMES:
                downs.append(dark_at)
            else:
                downs.append(k)
            dark_at = None
        elif lit and s[k] < off:
            lit = False
            dark_at = k
    return downs


def audio_times(events, mp4, duration, workdir):
    """Move each lattice key-down to its audio attack: isolated events (no other key-down
    within 150 ms) to the rise of the high-passed envelope in the overlay-lead window,
    crowded ones by the take's median lead (trim.video_onsets, per key)."""
    wav = os.path.join(workdir, "take.wav")
    trim.extract_wav(mp4, 0, 0.0, duration, wav)
    au = trim.TakeAudio(wav)
    ts = sorted({e["t_video"] for e in events})
    iso = {}
    for i, t in enumerate(ts):
        iso[t] = (i == 0 or t - ts[i - 1] > 0.15) and (i == len(ts) - 1 or ts[i + 1] - t > 0.15)
    leads = []
    for e in events:
        t = e["t_video"]
        if not iso[t]:
            continue
        lo, hi = (trim.LAST_LO, trim.LAST_HI) if (t == ts[-1] or e["frame"] == 0) else (trim.LAG_LO, trim.LAG_HI)
        rise, tr, _ = au.rise(t, lo, hi)
        if rise >= trim.RISE_DB:
            e["t"], e["timing"] = tr, "audio"
            if e["frame"] > 0:
                leads.append(tr - t)
    leads.sort()
    lead = leads[len(leads) // 2] if leads else 0.08
    for e in events:
        if "t" not in e:
            e["t"], e["timing"] = e["t_video"] + lead, "lead"
    return lead, len(leads), au


def _lis(points):
    """Longest chain of (beat, t) points with t non-decreasing in beat order."""
    pts = sorted(points)
    tails, tail_i, prev = [], [], [-1] * len(pts)

    for i, (b, t) in enumerate(pts):
        j = bisect.bisect_right(tails, t)
        if j == len(tails):
            tails.append(t); tail_i.append(i)
        else:
            tails[j] = t; tail_i[j] = i
        prev[i] = tail_i[j - 1] if j > 0 else -1
    out, i = [], tail_i[-1] if tail_i else -1
    while i >= 0:
        out.append(pts[i]); i = prev[i]
    return out[::-1]


class TempoMap:
    """beat -> seconds, piecewise linear through the median time of each matched beat."""
    def __init__(self, pairs):
        chain = _lis(pairs)
        by = {}
        for b, t in chain:
            by.setdefault(b, []).append(t)
        self.b = np.array(sorted(by))
        self.t = np.array([float(np.median(by[b])) for b in self.b])
        if len(self.b) < 2:
            raise ValueError("too few matched notes for a tempo map")

    def __call__(self, b):
        B, T = self.b, self.t
        if b <= B[0]:
            j = min(len(B) - 1, int(np.searchsorted(B, B[0] + 2)))
            return T[0] + (b - B[0]) * (T[j] - T[0]) / (B[j] - B[0])
        if b >= B[-1]:
            j = max(0, int(np.searchsorted(B, B[-1] - 2)) - 1)
            return T[-1] + (b - B[-1]) * (T[-1] - T[j]) / (B[-1] - B[j])
        return float(np.interp(b, B, T))

    def beat_len(self, b):
        return max(0.05, self(b + 0.5) - self(b - 0.5))

    def inverse(self, t):
        B, T = self.b, self.t
        if t <= T[0]:
            return B[0] - (T[0] - t) / max(1e-6, self.beat_len(B[0]))
        if t >= T[-1]:
            return B[-1] + (t - T[-1]) / max(1e-6, self.beat_len(B[-1]))
        return float(np.interp(t, T, B))


def _align_key(presses, times, tm):
    """Monotone DP match of one key's score presses (beats) to its key-down times."""
    n, m = len(presses), len(times)
    pred = [tm(b) for b in presses]
    INF = 1e18
    D = np.full((n + 1, m + 1), INF)
    D[0, :] = np.arange(m + 1) * 1.0
    D[:, 0] = np.arange(n + 1) * 1.0
    gap = 1.0                                    # skip cost, in units of a match error of one beat
    back = {}
    for i in range(1, n + 1):
        bl = tm.beat_len(presses[i - 1])
        for j in range(1, m + 1):
            err = abs(times[j - 1] - pred[i - 1]) / bl
            best, arg = D[i - 1, j] + gap, (i - 1, j)
            if D[i, j - 1] + gap < best:
                best, arg = D[i, j - 1] + gap, (i, j - 1)
            if err < 0.75 and D[i - 1, j - 1] + err < best:
                best, arg = D[i - 1, j - 1] + err, (i - 1, j - 1)
            D[i, j], back[(i, j)] = best, arg
    pairs, i, j = [], n, m
    while i > 0 and j > 0:
        pi, pj = back[(i, j)]
        if (pi, pj) == (i - 1, j - 1):
            pairs.append((i - 1, j - 1))
        i, j = pi, pj
    return pairs[::-1]


def align(notes, events, duration, end_beats, barlines, visible):
    """Assign every score note an onset time. Returns (stats, extra key-downs).

    Key-downs are matched per key, in order, against a tempo map (beat -> s) that
    is seeded from keys whose press and key-down counts agree and refined from
    the matches. Two loop structures are recognized:
    - rotation: a looped video may start at a barline other than the first and
      play the opening bars after the last (Bad Apple starts at m5 and plays
      m1-m4 at the end); chosen when it orders the seed clearly better;
    - wrap: the video stops at the loop downbeat, so a closing section that
      repeats the opening (a pickup, or a bar that restates bar 1) is sounded by
      the loop restart: such a note is timed duration + the opening note's onset.
    Unmatched notes are labeled "after_end" (past the end and not sounded by
    the loop), "offscreen" (key outside the sampled lattice) or "interp" (visible
    but not detected); all three take their time from the tempo map."""
    by_key_e = {}
    for e in events:
        by_key_e.setdefault((e["q"], e["r"]), []).append(e)
    for v in by_key_e.values():
        v.sort(key=lambda e: e["t"])

    def rotation(R):
        if R == 0:
            return lambda b: b
        return lambda b: b - R if b >= R - 1e-9 else b - R + end_beats

    def seed_for(rot):
        """Equal-count keys paired in order; None if the rotation lands two distinct
        presses of one key on the same beat (a pickup folded onto the closing bar)."""
        by_s = {}
        for n in notes:
            by_s.setdefault((n["q"], n["r"]), {})[round(n["onset_beats"], 9)] = round(rot(n["onset_beats"]), 9)
        out = []
        for k, m in by_s.items():
            bs = sorted(m.values())
            if len(set(bs)) != len(bs):
                return None
            if len(bs) == len(by_key_e.get(k, [])):
                out += [(b, e["t"]) for b, e in zip(bs, by_key_e[k])]
        return out

    base = len(_lis(seed_for(rotation(0))))
    R, best = 0.0, base
    for x in barlines:
        if 0 < x < end_beats:
            sd = seed_for(rotation(x))
            n_ = len(_lis(sd)) if sd is not None else -1
            if n_ > best:
                R, best = x, n_
    if best < base * 1.05 or best - base < 8:
        R = 0.0
    rot = rotation(R)
    presses = {}
    for n in notes:
        presses.setdefault((n["q"], n["r"], round(rot(n["onset_beats"]), 9)), []).append(n)
    by_key_s = {}
    for (q, r, b) in presses:
        by_key_s.setdefault((q, r), []).append(b)
    for v in by_key_s.values():
        v.sort()
    seed = seed_for(rot)
    tm = TempoMap(seed)
    for _ in range(3):
        match = {}
        for k, bs in by_key_s.items():
            es = by_key_e.get(k, [])
            for i, j in _align_key(bs, [e["t"] for e in es], tm):
                match[(k[0], k[1], bs[i])] = es[j]
        tm = TempoMap([(b, e["t"]) for (q, r, b), e in match.items()])
    # same pitch on another key: an unmatched press and an unmatched key-down with equal
    # nominal MIDI at the predicted time are one note, played somewhere the score does not say
    taken = {id(e) for e in match.values()}
    spare = [e for e in events if id(e) not in taken]
    elsewhere = 0
    for key in sorted(k for k in presses if k not in match):
        q, r, b = key
        midi = 57 + 4 * q + 7 * r
        cands = [e for e in spare if id(e) not in taken and 57 + 4 * e["q"] + 7 * e["r"] == midi
                 and abs(e["t"] - tm(b)) < 0.75 * tm.beat_len(b)]
        if cands:
            e = min(cands, key=lambda e: abs(e["t"] - tm(b)))
            match[key] = e
            taken.add(id(e))
            elsewhere += 1
    # loop wrap: the period (a barline, or the score end) that gives the most unmatched
    # tail presses an opening partner sounding at duration + its onset
    by_beat = {(q, r, round(b, 6)): e for (q, r, b), e in match.items()}
    tail = [k for k in presses if k not in match and tm(k[2]) >= duration - 0.25 * tm.beat_len(k[2])]

    def partner(key, P):
        q, r, b = key
        e = by_beat.get((q, r, round(b - P, 6)))
        return e if e is not None and abs(duration + e["t"] - tm(b)) < 0.5 * tm.beat_len(b) else None

    period, wraps = None, {}
    if tail:
        for P in sorted({round(rot(x), 9) for x in barlines if round(rot(x), 9) > 0} | {end_beats}):
            w = {k: partner(k, P) for k in tail}
            w = {k: e for k, e in w.items() if e is not None}
            if len(w) > len(wraps):
                period, wraps = P, w
    used, counts = set(), dict(loop=0, after_end=0, offscreen=0, interp=0)
    for key, ns in presses.items():
        q, r, b = key
        e, wrap = match.get(key), wraps.get(key)
        for n in ns:
            if e is not None:
                n["onset_s"], n["timing"] = e["t"], e["timing"]
            else:
                if wrap is not None:
                    n["onset_s"], n["timing"] = duration + wrap["t"], "loop"
                else:
                    n["onset_s"] = tm(b)
                    n["timing"] = ("after_end" if key in tail else
                                   "offscreen" if (q, r) not in visible else "interp")
                counts[n["timing"]] += 1
            src = e if e is not None else wrap
            if src is not None and (src["q"], src["r"]) != (q, r):    # played on another key: report that key
                n.setdefault("score_q", q)
                n.setdefault("score_r", r)
                n["q"], n["r"] = src["q"], src["r"]
                n["name"], n["midi"] = coord_label(src["q"], src["r"]), 57 + 4 * src["q"] + 7 * src["r"]
        if e is not None:
            used.add(id(e))

    def unrot(b):
        return b if R == 0 else (b + R if b + R < end_beats else b + R - end_beats)

    extras = [dict(q=e["q"], r=e["r"], name=coord_label(e["q"], e["r"]), onset_s=e["t"], timing=e["timing"],
                   est_beats=unrot(tm.inverse(e["t"]))) for e in events if id(e) not in used]
    # sequential check: a matched onset earlier than an onset at a strictly earlier (working) beat
    order, worst, run_max, prev_b, cur_max = 0, 0.0, -1e9, None, -1e9
    for b, t in sorted((k[2], e["t"]) for k, e in match.items()):
        if b != prev_b:
            run_max, prev_b = max(run_max, cur_max), b
        if t < run_max - 0.06:
            order += 1
            worst = max(worst, run_max - t)
        cur_max = max(cur_max, t)
    return dict(presses=len(presses), matched=len(used), played_elsewhere=elsewhere, **counts,
                video_starts_at_beat=R, loop_period_beats=period, seed_pairs=len(seed),
                order_violations=order, worst_order_violation_s=round(worst, 4)), extras


AUDIO_ONLY_WIN = 0.06   # s either side of the predicted onset (well inside a fast 16th)


# Lattice crops for videos recorded with an older OBS scene than trim.LAYOUTS describes.
# moonlight: the lattice sits ~100 px lower (y 1050-1480) with the score right below it.
LATTICE_OVERRIDES = {"moonlight": "1080:430:0:1050"}


def analyze(name, lib, workdir, log=print):
    man, notes, checks = parse_hkc(os.path.join(lib, name + ".hkc"))
    mp4 = os.path.join(lib, name + ".mp4")
    info = video_info(mp4)
    crop = LATTICE_OVERRIDES.get(name) or trim.LAYOUTS.get((info["width"], info["height"]))
    if crop is None:
        raise ValueError(f"no lattice crop preset for {info['width']}x{info['height']}")
    counts = {}
    for n in notes:
        counts[(n["q"], n["r"])] = counts.get((n["q"], n["r"]), 0) + 1
    geo = fit_geometry(lighting_blobs(mp4, crop), counts)
    keys, S = sample_keys(mp4, crop, geo)
    fps = float(info["fps"])
    events = []
    for c, (q, r) in enumerate(keys):
        for k in key_downs(S[:, c], fps):
            events.append(dict(q=q, r=r, frame=k, t_video=k / fps))
    lead, n_audio, au = audio_times(events, mp4, info["duration_s"], workdir)
    visible = set(keys)
    unseen = sum(1 for n in notes if (n["q"], n["r"]) not in visible)
    stats, extras = align(notes, events, info["duration_s"], man["score_end_beats"], man["barlines"], visible)
    # a visible key that never showed the note (a re-strike whose 60 ms flash the overlay did not
    # publish): take the audio attack within AUDIO_ONLY_WIN of the tempo-map prediction, if there is one
    stats["audio_only"] = 0
    for n in notes:
        if n["timing"] == "interp":
            rise, tr, _ = au.rise(n["onset_s"], -AUDIO_ONLY_WIN, AUDIO_ONLY_WIN)
            if rise >= trim.RISE_DB:
                n["onset_s"], n["timing"] = tr, "audio_only"
                stats["interp"] -= 1
                stats["audio_only"] += 1
    out_notes = [dict(q=n["q"], r=n["r"], name=n["name"], midi=n["midi"],
                      onset_s=round(n["onset_s"], 4), onset_beats=round(n["onset_beats"], 6),
                      dur_beats=round(n["dur_beats"], 6), onset_quarters=round(n["onset_quarters"], 6),
                      dur_quarters=round(n["dur_quarters"], 6), staff=n["staff"], measure=n["measure"],
                      timing=n["timing"], **{k: n[k] for k in ("score_q", "score_r") if k in n})
                 for n in notes]
    for e in extras:
        e["onset_s"], e["est_beats"] = round(e["onset_s"], 4), round(e["est_beats"], 3)
    entry = dict(
        file=name + ".mp4", score=name + ".hkc", title=man["title"], composer=man["composer"],
        duration_s=info["duration_s"], frames=info["frames"], fps=fps, audio_duration_s=info["audio_duration_s"],
        width=info["width"], height=info["height"],
        time_signatures=man["time_signatures"], key_signatures=man["key_signatures"], tempo_marks=man["tempo_marks"],
        pickup_beats=man["pickup_beats"], pickup_quarters=man["pickup_quarters"], measures=man["measures"],
        score_end_beats=man["score_end_beats"], score_end_quarters=man["score_end_quarters"],
        alignment=dict(notes=len(notes), **stats, lattice_crop=crop,
                       unseen_key_notes=unseen, key_downs=len(events), extra_key_downs=len(extras),
                       audio_timed=n_audio, overlay_lead_s=round(lead, 4),
                       lattice=dict(spacing_px=round(geo["spacing"], 2), angle_deg=round(geo["angle_deg"], 2),
                                    blob_hits=geo["blob_hits"], blobs=geo["blobs"], runner_up=geo["runner_up_hits"]),
                       score_checks=checks),
        notes=out_notes, extra_key_downs=extras)
    return entry


# ---------------------------------------------------------------- main

LIB = os.environ.get("HKL_LIB_DIR", os.path.expanduser("~/Videos/Lumatone"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("titles", nargs="*", help="titles (default: every <lib>/<name>.hkc with a matching .mp4)")
    ap.add_argument("--lib", default=LIB)
    ap.add_argument("--out", help="JSON output path")
    ap.add_argument("--score-only", action="store_true", help="parse scores and print self-checks only")
    a = ap.parse_args()
    names = a.titles or sorted(f[:-4] for f in os.listdir(a.lib) if f.endswith(".hkc"))
    if a.score_only:
        for name in names:
            man, notes, checks = parse_hkc(os.path.join(a.lib, name + ".hkc"))
            ts = ", ".join(t["sig"] + ("" if t["beat_groups"] == [1] * t["beats_per_bar"] else f"[{'+'.join(map(str, t['beat_groups']))}]")
                           for t in man["time_signatures"])
            ks = ", ".join(k["name"] or str(k["fifths"]) for k in man["key_signatures"])
            print(f"{name:14} {len(notes):5} notes  {man['measures']:3} bars  pickup {man['pickup_beats']:g}b  "
                  f"end {man['score_end_beats']:g}b  [{ts}] [{ks}]  {man['title']} / {man['composer']}")
            for c in checks:
                print("    !", c)
        return
    if not a.out:
        trim.die("--out is required")
    videos, skipped, failed = [], [], []
    with tempfile.TemporaryDirectory() as wd:
        for name in names:
            if not os.path.exists(os.path.join(a.lib, name + ".mp4")):
                skipped.append(name)
                continue
            try:
                e = analyze(name, a.lib, wd)
            except Exception as ex:      # one bad video must not lose the rest of the library
                print(f"{name:14} FAILED: {type(ex).__name__}: {ex}", flush=True)
                failed.append(dict(file=name + ".mp4", error=f"{type(ex).__name__}: {ex}"))
                continue
            al = e["alignment"]
            print(f"{name:14} {al['notes']:4} notes  matched {al['matched']}/{al['presses']} presses  "
                  f"elsewhere {al['played_elsewhere']}  loop {al['loop']}  after_end {al['after_end']}  "
                  f"offscreen {al['offscreen']}  audio_only {al['audio_only']}  interp {al['interp']}  extra {al['extra_key_downs']}  "
                  f"start {al['video_starts_at_beat']:g}b  period {al['loop_period_beats']}  "
                  f"order {al['order_violations']} ({al['worst_order_violation_s'] * 1000:.0f} ms)  "
                  f"lead {al['overlay_lead_s'] * 1000:.0f} ms  audio-timed {al['audio_timed']}/{al['key_downs']}", flush=True)
            videos.append(e)
    if skipped:
        print("no matching .mp4:", ", ".join(skipped))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(dict(generated_by="tools/obs-trim/align.py", library=a.lib, videos=videos, failed=failed), f,
                  ensure_ascii=False, indent=1)
    print("wrote", a.out)

if __name__ == "__main__":
    main()
