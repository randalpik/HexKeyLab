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

## `hkltrim` — the command

`tools/obs-trim/hkltrim` wraps `trim.py` with the library layout baked in
(`~/Videos/obs/TITLE.mkv` → `~/Videos/Lumatone/TITLE.mp4`; override with
`HKL_OBS_DIR` / `HKL_LIB_DIR`). Install once as a global command:

```sh
ln -s ~/HexKeyLab/tools/obs-trim/hkltrim ~/.local/bin/hkltrim
```

```sh
hkltrim title            # onset table for the last take
hkltrim title +0.5 -p    # audition: end = last onset + 0.5 s
hkltrim title +0.5       # encode (refused if the mp4 exists — it may be posted; -f overwrites)
hkltrim title 446.20     # absolute end; -0.1 = last onset − 0.1 s
hkltrim title -l         # take list; -n prints the command instead of running it
```

Anything else (`--take 1-2`, `--fade-out 0.01`, …) is passed through to
`trim.py`.

## Workflow (trim.py directly)

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

`--take` defaults to `-1` (the last take); `--take 1-2` spans takes, `--take
all` is the whole file. **A rest of more than `--gap` seconds (2 s) of digital
silence inside one piece shows up as two takes** and must be spanned by hand;
such fermatas are rare (Op. 28 No. 4's 1.93 s pause before its closing chords
is the longest on record and fits under 2 s). The gap cannot go higher: a
legitimate take has followed as little as 2.26 s of setup silence. `--list`
prints the silence gap before each take, and the tool prints a hint when the
chosen take borders a gap under 3 s. `--end` forms:

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

- Takes are separated by silences ≥ `--gap` (2 s). A piece with a true
  digital-silence rest longer than that splits into two "takes"; span them
  with `--take A-B` / `--take all`. Do not raise `--gap`: a legitimate take has
  followed 2.26 s of setup silence (library minimum over 35 kept takes, 2.70 s
  for the rest), while the longest rest inside a kept take is 0.62 s.
- A click at the loop seam in one player but not in Audacity is the player,
  not the file: Audacity loops the wav sample-accurately. Raise `--pre` if the
  click is on the head side, `--tail-silence` (try 0.02) if on the tail side.
- A thump at the seam on bass-heavy endings means the ramp is shorter than a
  quarter period of the lowest partial: raise `--fade-out` to 10–20 ms.
- `--audio-track N` selects an OBS audio track (default 0).

## `align.py` — per-note performance data for the library

`align.py` pairs every `<lib>/<name>.mp4` with `<lib>/<name>.hkc` and writes one
JSON file: per video a manifest (file, title, composer, exact duration =
frames / fps, time/key signatures with beat grouping, tempo marks, pickup, score
end) and every note, ties merged:

| field | meaning |
| --- | --- |
| `q`, `r`, `name`, `midi` | the key that was **played** (sounding: 8va spans applied) |
| `score_q`, `score_r` | the score's own `data-q`/`data-r`, only when they differ (8va, or an alternate key for the same pitch) |
| `onset_s` | onset in video seconds, at the audio attack |
| `onset_beats`, `dur_beats` | beats from the first downbeat (a pickup is negative); `hkl:beat-groups` defines the beat, else compound meters beat in dotted units |
| `onset_quarters`, `dur_quarters` | the same in quarter notes |
| `timing` | where `onset_s` came from (below) |

```sh
tools/obs-trim/align.py --out perf.json          # whole library
tools/obs-trim/align.py furelise tetris --out x.json
tools/obs-trim/align.py --score-only             # parse + self-checks, no video
```

**Key-downs** are read per hex, not per cell: lighting blobs give the hex
spacing and angle, and the `(q, r)` labelling (12 orientations × integer
offset) is fitted against the score's key histogram. Each key's *whiteness*
(min of R, G, B over a disk at its centre) is sampled per frame — a lit key is
its colour blended toward white, which a luma series misses on pale keys (a
pale-yellow key gains ~12 luma levels lit). A key-down is an unlit→lit
transition (hysteresis at 60 % / 40 % of the key's range; a key needs ≥ 30 of
contrast and a ≥ 30 jump between frames, which edge hexes over the camera never
reach), or the darkening of HKL's re-strike flash, as in `trim.py`. Each one is
then moved to its audio attack (`trim.TakeAudio`), or by the take's median
overlay lead when crowded.

**Matching** is per key and in order, against a tempo map seeded from keys
whose press and key-down counts agree. A press with no key-down on its key that
coincides with a spare key-down of the same nominal pitch elsewhere is that key
(`score_q`/`score_r` record the difference). Loop structures:

- **wrap** — the video stops at the loop downbeat, so a closing section that
  restates the opening (the pickup, or a last bar repeating bar 1) is sounded
  by the loop restart: `timing: "loop"`, onset = duration + the opening note's
  onset. The period is the barline that explains the most such notes
  (`loop_period_beats`).
- **rotation** — a video may start at a later barline and play the opening bars
  after the last (badapple: m5–m20 then m1–m4); chosen when it orders the seed
  clearly better (`video_starts_at_beat`).

`timing` values: `audio` / `lead` (detected; attack found / lead-shifted),
`loop`, `audio_only` (visible key showed nothing — a re-strike whose 60 ms
flash the overlay did not publish — but an attack sits within ±60 ms of the
prediction), `after_end` (past the end of the video and not sounded by the
loop), `offscreen` (key outside the sampled lattice), `interp` (visible, not
detected). The last three take the tempo-map time. `alignment` per video
counts each and lists `extra_key_downs` (trills, ornaments and notes not in the
score) with an estimated beat; `order_violations` counts matched onsets more
than 60 ms earlier than an onset at an earlier beat.

`LATTICE_OVERRIDES` holds crops for videos made with an older OBS scene than
`trim.LAYOUTS` describes (moonlight: lattice ~100 px lower, score right below).
