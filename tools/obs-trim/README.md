# obs-trim — loop-ready video from an OBS recording

`trim.py` cuts one take out of an OBS recording of an HKL performance into an
`.mp4` that loops seamlessly on the beat: a vertical short or a horizontal
clip that a looping player (YouTube Shorts, mpv) repeats with no gap or click
at the seam. It is made for recordings that show the HKL overlay
([docs/guide/overlay.md](../../docs/guide/overlay.md)): note onsets are read
off the overlay's lattice.

## Requirements

- Python 3; `trim.py` uses only the standard library.
- `ffmpeg`, `ffprobe` and `ffplay` on your `PATH`.
- Optional: aubio (`aubioonset`), only for `--audio-onsets`.

## What the recording needs

- **HKL's audio, alone, on one track.** HKL's output is digital silence
  whenever nothing sounds, and `trim.py` relies on that to find takes and
  attacks (threshold −60 dBFS, `--noise`). It reads OBS audio track 0; if the
  recording also carries a microphone, put HKL on a separate track and select
  it with `--audio-track N`.
- **Takes separated by at least 2 s of silence.** One `.mkv` can hold a whole
  session; each stretch of sound is a take.
- **The overlay's lattice in the frame.** `trim.py` reads onsets from a crop
  rectangle around the lattice. Two presets are chosen by frame size:
  1080×1920 (vertical: the lattice in a full-width band at y 970–1350) and
  1920×1080 (horizontal: x 40–1880, y 580–1060). For any other scene,
  including a different layout at one of those sizes, pass
  `--lattice W:H:X:Y` (ffmpeg crop order: width, height, left, top) and check
  it with `--onsets --crop-png crop.png`. The rectangle should cover the whole
  lattice and nothing else that moves; a "crop noise" warning means it caught
  camera.

## Workflow

```sh
T=tools/obs-trim/trim.py; S=path/to/session.mkv
$T $S out.mp4 --list                    # the takes in the file, with the silence before each
$T $S out.mp4 --onsets                  # onset table of the last take
$T $S out.mp4 --end last+0.5 --preview  # audition the seam: tail + head, looped
$T $S out.mp4 --end last+0.5            # encode
```

1. **Pick the take.** `--take` defaults to the last one (`-1`); `--take N`
   picks one from `--list` (negative counts from the end), `--take 1-2` spans
   takes and `--take all` uses the whole file.
2. **Find the end.** `--end` is the loop *downbeat* in source time: the moment
   the take's first note should recur when the player wraps around. Take it
   from the onset table, or find it by ear (Audacity's selection bar shows
   seconds).

   | form | meaning |
   | --- | --- |
   | `446.20` | absolute source time |
   | `+20.3` | onset + 20.3 s, i.e. an explicit loop length |
   | `last+0.5`, `last-0.1` | relative to the last detected onset of the take |

3. **Audition** with `--preview`. It writes `clip.wav` (the trimmed, faded
   audio) and `seam.wav` (the last `--seam` s and first `--seam` s, repeated
   `--loops` times) to a temp dir (`--workdir` to choose) and plays the seam
   with `ffplay`; `--no-play` only writes the files. Adjust `--end` (or
   `--fade-out`, under Notes) until the seam sounds right.
4. **Encode** once: the same command without `--preview`.

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
- The video is re-encoded (libx264 crf 18, AAC 256k) because OBS keyframes are
  ~2 s apart and a stream-copy cut would snap to one. ~8 s per 20 s clip at
  1080×1920@60.

## Onsets come from the lattice video, not the audio

`--onsets` (and `--end last±D`) read key events off the overlay's lattice. The
crop (a preset per frame size, covering the whole lattice; `--lattice`
overrides, `--crop-png` shows it) is reduced to a grid of 24 px cells, mean
luma each, so a hex spans two or three cells. Per cell, a lightening is a
key-down. A darkening that is re-lit within 6 frames is HKL's re-strike flash —
a re-struck key is painted unselected for 60 ms (`KEY_FLASH_MS`,
`apps/hkl/src/render/key-flash.ts`) and re-lit — and is a key-down at the
darkening frame, which is the note-on. A darkening not re-lit in time is a
key-up. (Timing re-strikes at the re-light instead was worth ~60 ms and
produced what looked like a bimodal overlay lag; merging each flash into a
"burst" lost a final re-strike whenever the release followed within a few
frames.) The lattice is pixel-static otherwise: a key changes a cell mean by
tens of levels against a floor of ~1. Audio onset detectors (aubio) swallow
soft notes under a ringing decrescendo — on one take aubio put the last onset
at 19.8 s, the lattice at 21.8 s.

The overlay leads the captured audio by a per-session constant of roughly
70–120 ms (first lit key vs first audio sample above −60 dBFS; it is OBS's
audio-capture path, not jitter). So the lattice decides **which** events exist
and the audio decides **when**: each key-down is refined to the attack rise of
a first-difference (high-pass) 10 ms RMS envelope within the lag window after
it, when no other key-down is within 150 ms; crowded events are shifted by the
take's median lag. The probe is local, so it finds soft notes under a loud
decay that global detectors miss (on that take's last five notes aubio finds
nothing even at threshold 0.05; they rise 2–5 dB in the high-passed envelope).

A lattice change with no sound — a hover or a feather touch after the last
note — is a *trailing ghost*: it is dropped when its rise is under 2.5 dB and
the sound dies within 150 ms of it. `--audio-onsets` falls back to aubio alone.

Checked against 31 takes cut by hand: the last detected onset falls 0.08–10.3 s
before the hand cut (the long ones are final chords held to the end of their
decay; on a loop cut it is 80 ms). Where aubio finds the last attack the two
agree to within a few ms; on the takes where it doesn't, aubio is 0.4–3.1 s
early.

## Notes

- **A rest of more than `--gap` seconds (2 s) of digital silence inside one
  piece shows up as two takes**; span them with `--take A-B` or `--take all`.
  `--list` prints the silence before each take, and `trim.py` prints a hint
  when the chosen take borders a gap under 3 s. Raising `--gap` is not the
  fix: a legitimate take has followed as little as 2.26 s of setup silence.
  Such rests are rare; the longest seen so far, a 1.93 s fermata, fits under
  2 s.
- A click at the loop seam in one player but not in Audacity is the player,
  not the file: Audacity loops the wav sample-accurately. Raise `--pre` if the
  click is on the head side, `--tail-silence` (try 0.02) if on the tail side.
- A thump at the seam on bass-heavy endings means the ramp is shorter than a
  quarter period of the lowest partial: raise `--fade-out` to 10–20 ms.
