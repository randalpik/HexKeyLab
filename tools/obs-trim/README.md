# obs-trim — loop-ready mp4 from an OBS session recording

`trim.py` cuts one take out of an OBS `.mkv` session (HKL overlay + camera)
into an upload-ready `.mp4`, timed so the Shorts player loops it on the beat.

Requires `ffmpeg`/`ffprobe`/`ffplay` and `aubio` (`aubioonset`). Stdlib Python.

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
$T $S out.mp4 --take -1 --onsets        # aubio onset table for the last take
$T $S out.mp4 --end 446.20 --preview    # audition the seam: tail+head ×4
$T $S out.mp4 --end 446.20              # encode
```

`--take` defaults to `-1` (the last take). `--end` forms:

| form | meaning |
| --- | --- |
| `446.20` | absolute source time (read it off Audacity's selection bar in seconds) |
| `+20.3` | onset + 20.3 s, i.e. an explicit loop length |
| `last+0.5`, `last-0.1` | relative to the last aubio onset of the take |

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
