# HKL Analyzer Guide

The HKL Analyzer builds **sample-based instruments** for HexKeyLab out of audio you supply: a folder of recorded notes, or a public soundfont URL. It finds clean loop points so sustained notes can be held indefinitely, analyzes decay, and normalizes every sample to a consistent loudness, then packages the result as a `.hki` bundle (or a CDN config) you can load straight into HKL.

Open it at **`/analyzer/`** (same address as HKL, its own tab). It's a developer/power-user tool; you don't need it to play HKL, only to add new voices.

> To sample a *physical* instrument (a hardware synth or piano) rather than existing audio files, use the [Orchestrator](orchestrator.md) instead.

---

## What you need

Either of:

- **Local files**: a set of audio files, one per note, named by pitch (e.g. `A3.wav`, `C#4.mp3`). The Analyzer reads the pitch from the filename.
- **A CDN URL**: the base URL of a publicly hosted soundfont (e.g. a tonejs / gleitz / VCSL sample set). The Analyzer fetches notes from it on demand, so the host has to allow cross-origin requests, as the public sample sets do.

Any format your browser can decode works; WAV, FLAC, MP3 and Ogg are safe choices.

---

## The workflow

The page is five numbered cards, used in order:

1. **Source.** Drag local files onto the page (or use the file picker), or paste a CDN base URL. For a CDN, set the **file pattern** (how filenames are built, e.g. `{NOTE}.mp3`); **+ Add fallback pattern** adds more patterns for sets whose naming varies, and they are tried in order for each note.
2. **Configuration.** Set the **Instrument key** and **Display name**, the **Note style** the filenames use (flat, sharp, `Cs`-style or lowercase), the range (**Low octave** to **High octave**), and **Decays**: *false* for a sustained (looped) instrument, *true* for a decaying (struck or plucked) one. Use **Transpose (semitones)** if the recordings are pitched differently from their labels (e.g. some organs).
3. **Analyze.** Each sample is processed in the background: loop-point detection for sustained instruments, decay analysis for struck ones, and loudness measurement for all. With **Auto-select good samples** ticked, the Analyzer then picks which samples to use: about one every four semitones for a sustained instrument, every valid sample for a decaying one.
4. **Samples.** Each row shows a quality tier (color-coded), the number of loop segments found, and the gain. ▶ plays the sample with a moving playhead (listen for a seamless loop); ▸ opens its waveform chart. Tick or untick a row to choose which samples ship; red and failed rows are left out even if ticked.
5. **Output.** Local files export a self-contained **`.hki`** bundle (metadata + encoded audio); a CDN source exports a **config JSON** that points at the hosted files. Download it, or **Send to HKL** to load it into a connected HKL tab immediately.

Your work is auto-saved as you go. Reload the page and your source, config, and selections come back.

---

## Reading the quality tiers

For a **sustained** (looped) sample, the tier says how much loop variety the Analyzer found:

- **Green**: four or more loop segments that can chain forever, mostly direct.
- **Blue**: four or more, but at least half of them are bridges, so there is less variety.
- **Yellow**: exactly three segments; the loop works but repeats more audibly.
- **Red**: two or fewer, or no set of segments that can repeat forever. Red samples are left out.
- **Fail**: no loop segments at all.

For a **decaying** sample:

- **Green**: the detected pitch matches the filename's label.
- **Yellow**: more than 50 cents off the label, which usually means mislabeled files or a missing transpose.
- **Fail**: no fundamental found.

If a sustained sample comes up red, try a different recording of that note, or adjust the **Advanced — gate thresholds** panel; the defaults handle most material.

---

## Loading into HKL

Once an instrument is in HKL (via **Send to HKL**, or by importing the downloaded `.hki` with HKL's **Import** button on the Playback tab), it appears at the bottom of HKL's instrument dropdown and persists across reloads. Play a note to hear it.
