# obs-trim — loop-ready mp4 from an OBS session recording

`trim.py` cuts one take out of an OBS `.mkv` session (HKL overlay + camera)
into an upload-ready `.mp4`, timed so the Shorts player loops it on the beat.

Requires `ffmpeg`/`ffprobe`/`ffplay`. `trim.py` is stdlib Python; `aubio`
(`aubioonset`) is only needed for `--audio-onsets`; `validate.py` needs numpy
and aubio (for its comparison column).

## Loop model

- **Start** = the first onset of the chosen take, found by `silencedetect`
  (−60 dBFS). HKL's output is digital silence before the first note, so the
  crossing sits within ~2 ms of the attack.
- **Seam margins.** The clip is `[onset − pre, end − pre]` with `--pre` =
  25 ms of digital zero before the attack, *taken from the tail* so the loop
  period is unchanged. One AAC (21.3 ms) or Opus (20 ms) frame of player slop
  at the stream start — a late seek, an edit list applied twice — then still
  lands in silence instead of mid-attack (the first Shorts upload clicked at
  the start with a 5 ms margin). `--tail-silence` adds zeros after the
  fade-out for players that flush the tail at the loop seek (Haruna/mpv do;
  Shorts did not). The video track starts at 0 and is CFR, so the container,
  video and audio durations are all exactly the loop period.
- **End (`--end`)** = the loop *downbeat* in source time: where the first onset
  should recur when the player wraps. Everything after it — the decay — is
  truncated. **Loop period = end − onset**, snapped to the video frame grid so
  the audio and video streams have identical durations (≤ ½ frame of drift).
- **Fades are declick ramps only** (5 ms raised-cosine in and out, `--fade-in`
  / `--fade-out` / `--curve`). They are not musical fades: at the loop point
  the tail ramps to zero over 5 ms and the attack starts from zero, which is
  short enough to repeat seamlessly at 16th-note rates.
- The video is re-encoded (libx264, crf 18) because OBS keyframes are ~2 s
  apart and a stream-copy cut would snap to one. ~8 s per 20 s clip at
  1080×1920@60.

## Workflow

```sh
T=tools/obs-trim/trim.py; S=~/Videos/obs/session.mkv
$T $S out.mp4 --list                    # sound segments (takes) in the file
$T $S out.mp4 --take -1 --onsets        # onset table for the last take (from the lattice video)
$T $S out.mp4 --end 446.20 --preview    # audition the seam: tail+head ×4
$T $S out.mp4 --end 446.20              # encode
```

## Onsets come from the lattice video, not the audio

`--onsets` (and `--end last±D`) read key events off the overlay's lattice. The
crop (a preset per frame size in `LAYOUTS`, covering the whole lattice;
`--lattice W:H:X:Y` overrides, `--crop-png out.png` shows it) is reduced to a
grid of 24 px cells, mean luma each, so a hex spans two or three cells. Per
cell, a lightening is a key-down. A darkening that is re-lit within 6 frames is
HKL's re-strike flash — a re-struck key is painted unselected for 60 ms
(`KEY_FLASH_MS`, `apps/hkl/src/render/key-flash.ts`) and re-lit — and is a
key-down at the darkening frame, which is the note-on. A darkening not re-lit
in time is a key-up. (Timing re-strikes at the re-light instead was worth ~60 ms
and produced what looked like a bimodal overlay lag; merging each flash into a
"burst" lost a final re-strike whenever the release followed within a few
frames.) The lattice is pixel-static otherwise: a
key changes a cell mean by tens of levels against a floor of ~1. Audio onset
detectors (aubio) swallow soft notes under a ringing decrescendo — on
`revolutionary` aubio put the last onset at 19.8 s, the lattice at 21.8 s.

The overlay leads the captured audio by a per-session constant of roughly
70–120 ms (first lit key vs first audio sample above −60 dBFS, measured on the
whole library; it is OBS's audio-capture path, not jitter). So the lattice
decides **which** events exist and the audio decides **when**: each key-down is
refined to the attack rise of a first-difference (high-pass) 10 ms RMS envelope
within the lag window after it, when no other key-down is within 150 ms;
crowded events are shifted by the take's median lag. The probe is local, so it
finds soft notes under a loud decay that global detectors miss (the last five
notes of `revolutionary` give aubio nothing even at threshold 0.05; they rise
2–5 dB in the high-passed envelope).

A lattice change with no sound — a hover or a feather touch after the last
note — is a *trailing ghost*: it is dropped when its rise is under 2.5 dB and
the sound dies within 150 ms of it. Three of the library's hand-cut files end
exactly before such a ghost. `--audio-onsets` falls back to aubio alone.

`validate.py` checks the detector against the hand-cut library: every
`<lib>/<name>.mp4` is located in `<obs>/<name>.mkv` by FFT cross-correlation
of its head and tail, the cut is mapped into source time, and the last detected
onset should sit a little before it (`d_vid ≥ 0`). 2026-10-14, final detector:
31/31 files with the last onset 0.08–10.3 s before the cut — the long tails
are held final chords cut at the end of their decay (moonlight1 10.3 s,
prelude28-20 7.2 s, gymnopedie 3.1 s); on the loop cut (`revolutionary`) it is
80 ms. Where aubio sees the last attack the two agree to a few ms; where it
does not (`revolutionary`, `mirror`, `resurrections`, `intermezzo`,
`liebestraum`, `nocturne9-1`…) aubio is 0.4–3.1 s early. Per-session
video→audio lag quartiles sit within 10–25 ms of each other. Run it alone — it
decodes every matched take at full resolution.

`--take` defaults to `-1` (the last take). `--end` forms:

| form | meaning |
| --- | --- |
| `446.20` | absolute source time (read it off Audacity's selection bar in seconds) |
| `+20.3` | onset + 20.3 s, i.e. an explicit loop length |
| `last+0.5`, `last-0.1` | relative to the last detected onset of the take |

`--preview` writes `clip.wav` (the trimmed, faded audio) and `seam.wav`
(last `--seam` s + first `--seam` s, repeated `--loops` times) to a temp dir
(`--workdir` to choose) and plays the seam with `ffplay`. Add `--no-play` to
just write the files. Iterate on `--end` / `--fade-out` here; encode once.

## Notes

- Takes are separated by silences ≥ `--gap` (1 s). A piece with a true
  digital-silence rest longer than that splits into two "takes"; use
  `--start <seconds>` to override, or raise `--gap`.
- A click at the loop seam in one player but not in Audacity is the player,
  not the file: Audacity loops the wav sample-accurately. Raise `--pre` if the
  click is on the head side, `--tail-silence` (try 0.02) if on the tail side.
- A thump at the seam on bass-heavy endings means the ramp is shorter than a
  quarter period of the lowest partial: raise `--fade-out` to 10–20 ms.
- `--audio-track N` selects an OBS audio track (default 0).
