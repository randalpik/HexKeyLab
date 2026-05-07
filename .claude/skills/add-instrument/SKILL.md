---
name: add-instrument
description: "Generate a new HexKeyLab sample-set from a CDN folder of pitched audio samples. TRIGGER when the user asks to 'add an instrument', 'try this soundfont', 'analyze samples from <URL>', or provides a CDN base URL with implied intent to integrate. Wraps analyzer/generate-samples.js + analyzer/insert-instrument.js."
---

# add-instrument — CDN folder → analyzed sample set → samples.ts entry

The skill walks an instrument from a CDN URL through the existing analyzer
pipeline (`analyzer/generate-samples.js`) into `src/audio/samples.ts`. It
hands the user diagnostics before any commit, then waits for approval.

## When this fires

- User gives a CDN base URL and asks to integrate
- User says "add a new instrument", "try this soundfont", "analyze
  this folder"
- User mentions a specific soundfont folder on tonejs.github.io,
  gleitz.github.io/midi-js-soundfonts, raw.githubusercontent.com,
  etc., with implied intent to add

If the user's intent is just to *probe* a CDN ("what does this sound
like?") without integration, point them at the analyzer's HTML UI
instead — this skill is for the full add-to-repo flow.

## Inputs to gather

The skill must collect enough config to run `generate-samples.js`. If
the user only gave a URL, ask:

1. **Decay or sustain?** (`decays: true|false`). This picks the
   pipeline. Strings/winds/organs → sustain (false). Piano, harp,
   plucked, percussive → decay (true). If unsure, ask the user — it's
   the most consequential field.
2. **Octave range** (`lowOct`, `highOct`). Defaults to fetching
   1–7 if user doesn't know; missing notes 404 silently.
3. **Display name** (`displayName`). Title-cased, used in the HKL UI.
4. **Instrument key** (`instrumentKey`). The JS object key in
   `samples.ts`. Snake-case, derived from name unless user overrides.
5. **For sustain only — vibrato?** (`vibrato: true|false`). True for
   anything with periodic AMP/PITCH modulation: orchestral strings,
   flute, drawbar organ, vocal pads. False for steady tones like
   reed organ. If unsure, default to `true` and rely on the analyzer
   to fall back to "no modulation" failure.
6. **Octave-mismatch convention** (`transpose: N`). 2 for Hammond/
   FatBoy drawbar (filenames an octave above content). 1 for
   everything else. If user says "I think the filenames are an octave
   off," use 2; if unsure, leave 1 and the analyzer's
   `'no fundamental at labeled freq'` failures will reveal mismatch.

Reasonable defaults for fields the user probably won't care about:

- `releaseTime`: 0.3 for strings, 0.2 for winds, 0.15 for organs,
  0.1 for percussive, 0.5+ for harp/decay-heavy. Pick from instrument
  family or ask if ambiguous.
- `volume`: 1.0
- `noteStyle`: "flat" (FluidR3, MusyngKite, FatBoy use this);
  "sharp" for VCSL; "salamander" for Tone.js piano.
- `filePattern`: "{NOTE}.mp3" unless user says otherwise.
- `gateOpts`: `{}` (override only if a known instrument needs it —
  trombone uses `{corrThreshold:0.99, rmsStepThreshold:0.08}`,
  reed organ uses `{cliqueThreshold:0.15, minSpacingSec:0.075}`).

## Workflow

1. **Gather config** via AskUserQuestion if needed. Don't guess
   `decays` or `vibrato` — those drive the pipeline.

2. **Write the config** to `analyzer/configs/<key>.json`. If a config
   with that key already exists, ask before overwriting.

3. **Run the generator** with `Bash`:
   ```
   node analyzer/generate-samples.js analyzer/configs/<key>.json
   ```
   This fetches (cached on subsequent runs), decodes, analyzes,
   classifies, picks samples, and writes:
   - `analyzer/out/<key>-block.txt` (paste-ready JS)
   - `analyzer/out/<key>-report.md` (diagnostics)

4. **Surface the report** to the user. Highlight:
   - **Loop instruments**: tier distribution (green/blue/yellow/red/
     fail counts), audible range of the picks, any failures with
     suspicious patterns (all-fails at one end → range too wide;
     widespread `'no fundamental at labeled freq'` → likely
     octave mismatch, suggest `transpose: 2`).
   - **Decay instruments**: drift histogram (most should be within
     ±20¢; clusters at +1200/-1200¢ suggest octave-labeled-wrong;
     samples >50¢ off are suspect).
   - **Pick count**. Loop typically 12–20, decay typically equal to
     usable input count.

5. **Wait for approval.** Don't splice into `samples.ts` without
   explicit user OK. The user may want to inspect the block first or
   ask for changes (different range, different gateOpts).

6. **On approval**, run:
   ```
   node analyzer/insert-instrument.js analyzer/configs/<key>.json
   ```
   This finds the existing block (replace) or appends a new one. Then:
   ```
   npm run typecheck && npm run build
   ```
   Confirm both pass.

7. **If the instrument required a non-default convention** (transpose
   ≠ 1, custom gateOpts, unusual sampling style), append a brief
   entry to `docs/decisions.md` noting *why* the convention was
   chosen. Skip the docs entry for plain-vanilla instruments — there's
   nothing to document beyond the config file itself.

8. **Remind the user to audition** the new instrument before
   committing. The analyzer's quality classifier is a loop-coherence
   proxy (or pitch-coherence proxy for decay); it can't catch
   instruments that loop cleanly but sound wrong (recording artifacts,
   misnamed octaves that the heuristics didn't spot, etc.). Only the
   ear can confirm the result.

## Hard rules

- **Never splice without approval.** Always show the report first.
- **Never auto-commit.** The user controls when to `git commit`.
- **Don't invent CDN URLs.** If the user's URL 404s broadly, surface
  the failure and ask — don't try variants.
- **Don't tune `gateOpts` speculatively.** Defaults work for the
  vast majority of instruments. Override only when the analyzer
  reports a specific class of failure that maps to a known knob
  (per-instrument notes in `tools/HexKeyLab-analyzer.html`'s
  `DEFAULT_CONFIGS`).

## Failure modes and what to do

| Symptom | Likely cause | Fix |
|---|---|---|
| All samples fail `'no fundamental at labeled freq ±5%'` | filename labels an octave off audio (Hammond convention) | Set `transpose: 2`. Optionally autocorrelate one sample manually to confirm. |
| Loop path: most samples classified `red`/`fail` | wrong path — instrument has no usable sustain (it's a decay) | Switch `decays: true`, drop `vibrato`, regenerate |
| Loop path: most fail `'no modulation (best CV ...)'` | not a vibrato instrument, just a sustained one | Set `vibrato: false` to use macro-period |
| Decay path: drift histogram >50¢ everywhere | recording out of tune, OR octave-mismatch convention | Check audio against labeled freq with autocorrelation; consider `transpose: 0.5` if the file is an octave *below* the labeled name |
| `analyzer/out/<key>-block.txt` is empty | no usable samples in the range | Tighten the octave range or pick a different soundfont |

## See also

- `analyzer/README.md` — script-level documentation
- `tools/HexKeyLab-analyzer.html` — the in-browser analyzer UI; load
  `file://` locally to inspect a single sample's loop points visually
- `docs/decisions.md` — past decisions about sampling conventions and
  per-instrument overrides
