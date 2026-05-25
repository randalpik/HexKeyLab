# HexKeyLab Lessons Learned

Hard-won truths that aren't obvious from reading the code. Anti-patterns that burned us. Subtle behaviors that look like bugs but aren't. Read this before debugging anything that smells familiar, and add to it whenever something costs more than 30 minutes to figure out.

---

## Hardware

### The Lumatone expression jack is wired Roland-style

The expression jack expects the wiper signal on the **ring** of a TRS plug. Korg-style pedals (DS-1H, DS-2H, switch sustain pedals) put the pot between tip and sleeve and leave the ring unconnected. Plugged into the Lumatone, those pedals look like a floating ADC pin — slow capacitive drift downward, mechanical perturbations spiking to rail, no actual position information.

Two pedals with completely different electrical signatures producing identical behavior is the diagnostic tell. Calibration and sensitivity adjustments cannot rescue this — there is no signal on the read pin.

**Working pedals**: Roland DP-10 (with body switch in "Continuous" mode), Roland EV-5, Yamaha FC7 (with Invert Pedal toggle).

### Boards 3 and 4 are physically swapped on Max's unit

Every LTN file, SysEx push, and MIDI map must respect this via `sysexBoardMap = [1,2,3,5,4]`. This is a per-unit hardware quirk, not a firmware feature. If a build is generated with naive `[1,2,3,4,5]` mapping, key colors and remappings appear on the wrong physical boards.

### CC numbers for the pedal jacks are firmware-hardcoded

Sustain jack → CC 64 (binary). Expression jack → CC 4 (continuous). There is **no SysEx command to remap these**. The Editor doesn't expose it because the firmware doesn't support it. Don't waste time looking. HKL adapts by routing CC 4 → continuous damper handler internally.

### The Lumatone expression jack quantizes during calibration mode

While CMD 0x38 calibration is active, the firmware suppresses CC 4 emission and instead emits spontaneous CMD 0x3E status packets every ~100ms. CC 4 only resumes after calibration is exited. UI design: don't try to show "live CC 4" inside the calibration panel; either hide it during calibration or only update outside cal mode. We picked "remove it entirely" — a CC4 number in the cal panel was previously interpreted as broken when it stayed blank during a sweep, but the panel only renders during cal mode, so the field could never update. Better to leave the cal panel as ADC bounds + valid flag only.

### Calibrated CC 4 ceiling may not reach 127 in normal use

Calibration captures the *peak* ADC value during a sweep, then commits it as the upper bound. The firmware linearly maps live ADC to 0–127 against those bounds. If your steady-state full-press reading is a few counts below the peak you reached during cal (very common — pedals have a bit of mechanical "slam" headroom), the runtime CC 4 will top out at 124–126, not 127.

Two ways to deal with it: (1) recalibrate with softer max-press so the learned ceiling matches steady-state; (2) accept it. With the depth-as-gain damper model in HKL, gain=0.984 vs 1.0 is imperceptible — no need to tail-clamp in software. If a future feature genuinely needs the exact endpoint, the cheapest fix is `d2 ≥ 124 → 127` in the CC 4 handler.

### CC 4 at-rest sometimes emits 1 instead of 0 — causes intermittent stuck-sustain

The *bottom* of the calibrated range is symmetric to the top: the pedal's mechanical at-rest position can occasionally read one ADC count above the calibrated minimum, producing CC 4 = 1 as the final value of a release sweep instead of CC 4 = 0. With `pedal.cc4Depth = 1/127 ≈ 0.0078` and `DAMPER_RELEASE_FLOOR = 0.005`, that's above the floor — `setDamperDepth` keeps notes in `sustainedKeys` and held-but-released notes ring on indefinitely.

Manifests as intermittent stuck-sustain: notes hang after release until the next pedal press generates a fresh release-to-0 sweep. Diagnosed via the pedal HUD (`?pedaldiag=1`) + `pedal.dumpRecent()`: a stuck occurrence showed the tail of `recentEvents` ending with `value=1`, no `value=0` arriving.

Fix lives in `src/midi/handler.ts`: clamp `d2 <= 1` to `cc4Depth = 0`. We chose the input-boundary clamp over raising `DAMPER_RELEASE_FLOOR` because (a) the quirk is specifically about the bottom-of-travel reading, not a general "small depths are noise" issue; and (b) it makes the displayed `pedal.cc4Depth` correctly read 0 at rest rather than 0.0078.

### Web MIDI in Firefox requires a secure context

`file://` URLs do NOT work in Firefox. localhost or HTTPS only. Chromium permits `file://` for testing. Max develops with both browsers; the deployment target needs to assume Firefox + secure context.

### Firefox's `MIDIAccess` is a snapshot — no statechange events, no live port updates

Firefox does not dispatch `MIDIAccess.onstatechange` on hotplug, AND the existing port references in `access.outputs` / `access.inputs` don't update their `port.state` either. The access object is effectively a frozen snapshot of the moment `requestMIDIAccess` was called. Polling `findLumatone` against the existing access does nothing. Chromium dispatches statechange and updates port.state as the spec describes.

The only way to see a newly-plugged device in Firefox is to **re-call `navigator.requestMIDIAccess({sysex:true})`** and replace `midi.midiAccess`. Subsequent calls don't re-prompt for permission once granted. A fresh access yields fresh port state — and possibly fresh port *objects* with the same `id` — so identity checks in `findLumatone` must compare `port.id`, not JS object identity, or every refresh falsely fires the new-connection path.

**Don't refresh while connected.** A `requestMIDIAccess` call is heavy enough in Firefox to audibly glitch playback and disrupt outbound SysEx. We therefore poll-refresh ONLY while `midi.midiOut === null` (looking for connection). Once connected, the poll suspends; the user manually re-checks via a click on the `lumaStatus` indicator (`cursor: pointer`, tooltip wired in `requestMidi`) — or just refreshes the page — if they unplug. Chromium gets unplug-while-connected for free via `statechange`.

Poll cadence is `HOTPLUG_POLL_MS` in `src/midi/engine.ts`.

### Per-board threshold/sensitivity SysEx values are 4-bit, not 8-bit

Commands `0x29`, `0x2A`, `0x2B`, `0x2C`, `0x32` (per-board max/AT thresholds, min hysteresis, CC/AT sensitivity, CC active threshold) are documented in the Terpstra Editor source as taking 8-bit values (`0..0xFE`) packed as two nibbles. **The shipping firmware on Max's unit only honors the low nibble** — sending any non-zero high nibble breaks that board (notes stop registering until a reset). The clamp in HKL's `protocol.ts` builders is therefore 4-bit, and the lumadiag sliders are 0..15.

The read-back commands `0x3A` / `0x3B` still return the full byte (`hi<<4 | lo`), but in practice all valid stored values have hi=0 — useful as a sanity check that a board hasn't been corrupted.

Don't "fix" the clamp upward without first verifying empirically on the device — this was discovered the hard way.

### Per-KEY thresholds (via cmdSetMax/cmdSetMin) ARE full 8-bit

The 4-bit clamp above applies *only* to the per-board SysEx commands. The per-key threshold writes that happen at TC startup (`setMaxPic` / `setMinPic` / `setAftertouchMaxPic` sending PIC commands `cmdSetMax`=67, `cmdSetMin`=68, `cmdSetAftertouchMax`=89) are full 0..254. Values in the `KeyData_N` files routinely reach 70+ and work fine. Don't conflate the two layers.

### MAX threshold direction: HIGH = stricter, not more permissive

"Abs. distance from MAX ADC to trigger" means how far the sensor reading has to drop from its rest value before the key event fires. Hall sensors on the Lumatone are wired rest=high ADC, pressed=low ADC. So:
- **Higher MAX value → key must travel farther from rest before triggering** → if larger than the key's physical ADC swing, the key appears dead.
- **Lower MAX → light touch triggers**, at the cost of velocity compression toward fortissimo (shorter press-time measurement window).

For dead/weak keys, lower MAX. To recover compressed velocity range on weak-swing keys, *raise MIN* so the MIN-to-MAX gap shrinks proportionally. The gap is the press-time measurement budget.

### The PIC's calibration mode (0x24) can't be exited without hardware macro buttons

`sysexCallibrateKeys` (0x24) puts each PIC microcontroller into cal mode. The PIC commits and exits cal mode only on its own hardware macro-button signal — not on anything the BBB sends over UART. There is no PIC command for "end calibration" in the firmware's command enum. We verified this exhaustively (full disassembly of `decodePicMessage`, `setKeyboardMode`, `writeToPic`). When macro buttons are broken or disconnected, 0x24 calibration is unusable for that board and any subsequent SysEx threshold query for that board returns `STATE` (0x04) error until power-cycle.

Path forward when macro buttons are broken: skip 0x24 entirely. Edit per-key calibration directly via `tools/lumatone-cal/keydata-live.py`. See `docs/lumatone-calibration.md`.

### In-memory `kbd_preset_params` is indexed by PIC number, NOT spatial board

Two related quirks compound:
1. Boards 3 and 4 are physically swapped on Max's unit, so spatial position ≠ PIC number. `sysexBoardMap = [1, 2, 3, 5, 4]` translates spatial→PIC.
2. TC's in-memory per-board state and on-disk `KeyData_N` files are indexed by **PIC number** (the BBB doesn't know about the physical swap; it only sees electrical wiring). Memory slot `i` (0..4) corresponds to `KeyData_(i+1)` and to PIC `i+1`.

When poking memory for a key at HKL coords (q, r): compute `sysex_board = sysexBoardMap[board_group]`, then memory slot = `sysex_board - 1`. Using `board_group` as the slot index reads the WRONG board (the one physically swapped with the intended one).

### `writeToPic` doesn't clear bits — clearing happens in AckBitClear, and only for SET commands

TC's `writeToPic` dispatches based on bits in `picMessage0Flag[board]` but never clears them. Bit-clearing happens when the PIC acks the command, dispatched by `AckBitClear` keyed on the cmd byte. For GET commands (`cmdGetMax`=76, `cmdGetMin`=77, `cmdGetAftertouchMax`=96), `AckBitClear`'s case is the default no-op — the GET response is data, not a simple ack, and is handled by a different path in `decodePicMessage`.

Practical consequence: setting bit `0x4000000` (the cmdGetAftertouchMax dispatch bit) to spoof "calibration complete" causes the BBB to send the query repeatedly until something else clears it. Don't assume bit persistence means writeToPic isn't running; check by other means.

### Velocity randomness is NOT a noise-floor problem

Plausible theory that turned out wrong: with MIN=0, rest-position sensor noise crosses the MIN threshold randomly before the real press starts, jittering the press-time measurement and producing random-looking velocity output. The theory predicted "raising MIN above each key's noise floor will eliminate the randomness."

Empirically refuted: Max's keyboard with MIN=0 across all 280 keys shows **zero keys with CV > 0.3**. The "random velocity" symptom Max originally reported was actually a different problem masquerading — keys with constrained velocity range (Cluster B: p5≈50, p95≈90) feel inconsistent because the *narrow* range gets stretched across the user's intended dynamics. CV is low; range is what's wrong.

Don't chase the noise hypothesis. Diagnose with p5/p95, not CV.

### Velocity = inverse press-time; MIN and MAX are independent monotonic knobs

`press_time = time(ADC reaches rest−MAX) − time(ADC reaches rest−MIN)`. Press-time → bin → velocity LUT lookup. With identity LUT: shorter press-time = higher velocity.

- **Raise MIN** → timer starts later (smaller ADC traversal) → press-time *shorter* → velocity *higher*
- **Raise MAX** → timer ends later (larger ADC traversal) → press-time *longer* → velocity *lower*

Opposite directions. Both apply per-key (0..254 each in KeyData_N). Use MAX to drop the floor (p5), use MIN to raise the ceiling (p95). They cannot independently expand both ends — you're scaling and shifting a monotonic transform of press-time. The intrinsic dynamic range of any key is bounded by its physical ADC swing × the user's hand-speed range; threshold tuning only positions the velocity distribution within that envelope. Residuals beyond that are HKL's job (per-key gain + global curve in `velocityCal.ts`).

### Use p5/p95 to diagnose per-key calibration, not mean/CV

The natural metrics for "what's this key's realistic velocity range during normal play" are the outlier-rejecting percentiles, not the moments. lumadiag's per-key velocity statistics scatter plots (p5, p95) per key. The target zone is upper-left (p5 ≤ 30, p95 ≥ 100). Three failure modes diagnose directly from position:

| Position | Symptom | Action |
|---|---|---|
| Right of p5=30 line | Can't play quiet | Raise MAX |
| Below p95=100 line | Can't play loud | Raise MIN (or raise MAX if also right of floor line) |
| Near the y=x diagonal | Narrow range | Raise MAX; accept hardware ceiling; HKL gain/curve compresses low end |
| Top-right corner | Saturated high (Cluster A) | Raise MAX |
| Mid-diagonal (Cluster B) | Stuck middle | Raise MAX or MIN depending on which end matters more |

### Per-key calibration converges in 3-4 passes of bulk-raise + per-key rescue

When raising MAX globally to widen the velocity range, *some* keys (with small physical sensor swing) go dead at the new threshold. The cheap convergence pattern is asymmetric: raise globally, find casualties, rescue individually. `tools/lumatone-cal/keydata-live.py --bulk-raise <section> <value>` only writes keys whose current value is below the target, preserving prior per-key rescues across iterations.

Typical sequence: `--bulk-raise 1 100` → play → rescue ~10 keys → `--bulk-raise 1 130` → play → rescue ~3-5 keys → `--bulk-raise 1 160` → play → fewer rescues. Stop when further raises stop helping the "Can't play quiet" outlier list. ~1 hour total, vs. days of per-key bottom-up.

Do NOT use `--bulk` (without `-raise`) once you have rescues — it's unconditional and will clobber them.

---

## Tuning math

### r is the fifths axis, NOT the minor-thirds axis

Easy to misremember because the layout is called "Harmonic Table" and minor thirds have a natural place in harmonic tables. The r axis is **fifths** (3:2). Minor thirds are a derived direction (−1, +1) in (q, r). Verified empirically: lattice (0, 1) produces a frequency ratio of 3/2 above A3, i.e., a perfect fifth — not a minor third.

### Uniform-septimal qm=2 = B-d1-upper: derivation gotcha

The 7-limit (`tuning='7'`) mode makes every `qmod3=2` cell B-region with `(aDepth=1, aUpper=true)`. The non-obvious payoff: this places the harmonic 7th (7/4) of every qm=0 Pythag-spine cell exactly **two rows up in qm=2 at the same `r`** (the qm=2 cell at r=R+2 is 7/4 of the qm=0 cell at r=R, octave-equivalent). The geometry works because the qm=2 B-d1-upper syntonic adjustment cancels against the (q+1) major-third stack relative to the qm=0 reference.

Common confusion when reasoning about chord shapes in this mode:
- Half-diminished 7th = dom7-with-9th-replacing-root. Rooted at qm=1, NOT qm=0. From qm=1 r=R the four tones live at `qm=1 r=R (5)`, `qm=0 r=R+1 (6)`, `qm=2 r=R+2 (7)`, `qm=0 r=R+2 (9)` — gives 5:6:7:9 exact.
- Major triad still 5-limit-pure (4:5:6) via qm=0 + qm=1 of the same r. Septimal adjustment only touches qm=2 cells.
- 5-limit minor triad (10:12:15) is unreachable. Minor in this mode is Pythagorean (32:27, via qm=0) or septimal subminor (7:6, via qm=2). Use `'5'` mode when you want 5-limit minor.

### Octave-consistency in the 88-cell picker requires octave-normalized tiebreak

`compute88PianoCoords(refQ, refR)` walks MIDI 21..108 and picks the (q, r) per MIDI that minimizes TH to the ref. TH ties happen often (especially in 7-limit, where a B-region cell can tie TH=0 with the natural-lineage cell because the syntonic adjustment cancels against the (7,−4) shift's comma). The tiebreak has to keep each pitch class on its own ref-aligned octave lineage, otherwise Eb3 and Eb4 end up at different enharmonic spellings.

Correct tiebreak: `|proj − PROJ_PER_OCT · round((midi − refMidi) / 12)|` where `proj = 7(q − refQ) − 4(r − refR)` and `PROJ_PER_OCT = 21`. At the ref's MIDI this is `|proj|` (target = 0). At ref+12 it's `|proj − 21|`. Each pitch class collapses toward its own ref-aligned octave lineage.

Three earlier attempts that failed:
- **Zero-centered `|proj|` tiebreak**: works at the ref's octave; at others, the picker can pick a syntonic sibling and visually relocate the ref outside its own 88-cell footprint. Broke the "ref ∈ footprint" invariant.
- **Largest-`proj` tiebreak**: monotone, broke 469 octave-consistency cases empirically.
- **Minimum-`|proj|` Manhattan**: same as zero-centered at the ref's octave; same breakage.

The picker is in `src/render/draw.ts:compute88PianoCoords`.

### Diagonal MIDI band, not a square: the valid-ref scan

The valid-ref-region cache must iterate the diagonal MIDI band `4q + 7r ∈ [−36, 51]` exactly. The prior square scan `q ∈ [−30, 30], r ∈ [−30, 30]` missed valid refs at extreme q (e.g. at `r = −20` the band extends well past `q = 30`). Symptom: `validateRefNoteCandidate` passed the live check but the cached set didn't contain the ref, so the dotted outline showed false gaps and (when the cache was incorrectly the gate) refs were rejected with "Reference out of valid region."

Fix: `bandQRange(r) = [⌈(−36 − 7r)/4⌉, ⌊(51 − 7r)/4⌋]` and a nested loop with `r ∈ [−25, 25]` (the wider range still covers all cells the picker would visit at any reachable ref). The live `validateRefNoteCandidate` doesn't consult the cache at all — the cache exists only for the dotted visual outline.

### Pre-distribution code is allowed to break its own intermediate states

While HKL is unreleased, prefs / `.hkr` schema migrations from the user's *own* intermediate experiments are dead weight. The whole-codebase purge in 2026-05 deleted: the `'7-legacy'` tuning mode (`septimalMode='global'`, septimal seam-shift UI, 6-shift V7-legacy intersection cache), the 3-layout system (`curLayout`, `setLayout`, `applyLayoutImmediate`, `layoutShifts`, ♭/♮/♯ button group, ArrowLeft/Right cycle, QWERTY transpose ▲/▼), the `migrateTuningMode` / `normalizeRotation` / `isLayoutId` validators, and the `qwertyTranspose` snapshot field. Replaced with strict-validation persistence: any unrecognized scalar pref reverts to default; any unrecognized pref key is dropped.

This wouldn't be acceptable in a distributed app. Pre-release it's the right tradeoff: every retained migration is one more bit of state you have to keep working forever, and the only existing user is also the developer.

### Don't put validation rules in the cache, put them in the live validator

`validateRefNoteCandidate(q, r)` is the authoritative check on a candidate ref. Two and only two conditions: MIDI ∈ [21, 108] AND every cell in the 88-cell footprint spells with ≤±3 accidentals. The cached V5 / V7-uniform outline sets are precomputed visual aids; they are NOT a gate the validator consults.

Mixing them up is how "Reference out of valid region" false-rejects happen: a ref outside the cache's bounding box (or outside the cached set due to a stale build) passed the live check but failed the cache lookup. Fix is one-directional: validator runs LIVE per candidate; cache is built once for the visual outline; the two never compare.

### `reduce()` on large ratios loses precision past 2^53

JS numbers are 64-bit floats; integer precision breaks at 2^53. Several reference intervals (Pythagorean comma 531441/524288) and any compound interval crossing many octaves can hit this. Solution: use the exact prime exponent vector `e = [e2, e3, e5, e7]` returned by `reduce()` rather than dividing num/den. Trial-dividing num/den silently produces wrong results.

### Octave-multiple naming uses ET-style ordinals when commas are absent

Pure octave multiples (no reference interval, no commas) render as "perfect octave" / "perfect 15th" / "perfect 22nd" etc., matching ET conventions. Compound forms with commas like "2 octaves − syntonic comma" use `octStr` instead. Don't unify these — they reflect different musical situations.

### Interval naming must be spelling-driven, not ratio-driven

`intervalName(num, den)` — the prior ratio-only API — picked its base interval by Tenney-height ranking against a REF table. That collapsed enharmonic spellings: F#→D in V mode (rings near Pythag m6 + schisma) printed as "augmented 5th + syntonic comma" because aug 5th (25:16, TH ~8.6) outranks Pythag m6 (128:81, TH ~13.3) and both decompose to one comma. Same cents, same exponents, but two valid spellings; the scorer chose the wrong one.

Fix: feed coordinates to the naming function (`intervalNameFromCoords`), classify the spelling first (`classifyDiatonic` → `(ord, qual, extraOct)`), look up the Pythagorean reference exp from the spelling (`pythagRefExp` — closed-form, no table), then decompose the residual into commas. The spelling is the ground truth; the ratio is downstream. Side benefit: any niche Pythagorean ratio (Pythag d4 = 8192:6561 etc.) self-names via the algorithmic default `"Pythagorean <bare>"` for free — no per-class table entry needed.

Corollary: callers that only have `num:den` cannot do spelling-driven naming. There are none in the codebase now, and adding one would silently regress to the old bug. If a future caller appears, it must thread coords through, not invoke a ratio-only shortcut.

### Equal mode interval naming must use letter distance, not lattice displacement

`equalIntervalName()` computes intervals from actual `noteName() + keyOctave()`, NOT from raw lattice displacement `(2·dq + 4·dr)`. Band structure means lattice displacement and letter distance can diverge in Equal mode (where the band concept doesn't apply). Use the letter-distance path or you'll mislabel d2 vs A1 etc.

### Equal mode "rational interval" coloring uses `semis % 12`, not the ratio

In Equal mode, only octave-equivalent intervals are rational (unisons, octaves, and their enharmonic spellings: d2, A7, dd3, AA6, …). The check is `semis % 12 === 0` — green if true, red otherwise. The ratio-based TH coloring used in 5/7-limit doesn't apply because every other ET interval is irrational.

### `TuningMode` is dual-defined and exhaustive-Records propagate

`TuningMode` is declared in **two places** that must stay in sync: `src/state/persistence.ts` (HKL-side full app state) and `src/shared/freq.ts` (shared with Composer, kept self-contained so Composer-side modules don't pull in HKL state). When adding a new mode, you must update both type aliases AND the `TUNING_MODES` array in `freq.ts` — TypeScript won't catch the mismatch in `freq.ts` because nothing imports both definitions in a way that compares them.

Adding a mode also requires extensions in every `Record<TuningMode, …>` site (typecheck WILL catch these as exhaustiveness errors). Known sites: `MODE_LABELS` in `composer/notation/retune.ts`; `TUNING_LABELS` in `composer/setupDialog.ts` and `bridge/hkl-side.ts`; `PIANO_BOUNDS_TABLE` in `render/canvas.ts`; `VALID_REF_TABLE` in `render/refbounds-table.ts`; `validRefSetByMode` and `validRefPathsByMode` in `render/draw.ts`. Plus `isTuningMode` guards in `persistence.ts`, `recording/hkr.ts`, `composer/main.ts`, and `bridge/hkl-side.ts` (these are runtime guards, not exhaustive Records — typecheck won't flag missing entries). The selector `<option>` in `index.html` and `tuningDescription()` in `bridge/hkl-side.ts` are also required for the mode to be selectable and bridge-broadcasted.

`refbounds-table.ts` is generated by `tools/bounds-probe/`. To add an experimental mode without re-probing, refactor the generator output to a `Omit<Record<…>, 'V'>` `GENERATED` const and re-export `{ ...GENERATED, 'V': GENERATED.P }`. Same pattern works for `PIANO_BOUNDS_TABLE` (just copy P's numbers). Re-probe when the experimental mode graduates or its picker output diverges meaningfully from its alias.

### V mode dispatches diverge from Pythagorean in three non-obvious places

V mode reuses Pythagorean's region structure (same A_D1_LOWER for qm=1, A_D1_UPPER for qm=2) but diverges in three handlers that *don't* go through `regionInfoWithState`:

1. **`freqAt`** (`src/shared/freq.ts`) multiplies by `Math.pow(SCHISMA, b)` — the per-band schisma drift, separate from the qm shifts.
2. **`jiRatioWithState`** (`src/tuning/ratios.ts`) adds `db × (−15, +8, +1, 0)` to the prime-exponent vector after the standard region adjustments — the schisma's prime decomposition (3^8·5/2^15). Without this, cross-band intervals would compute incorrect ratios and the analyzer wouldn't surface "octave + schisma" annotations.
3. **`keyColorVariant`** (`src/render/colors.ts`) computes a dedicated V-mode index — `chainStep = floor((2q+1)/3)`, `idx = (5 − midiOct − 2·chainStep) mod 7` in `hueCycle`. V mode is the *only* mode that bypasses the SC-sibling redirect, because octave invariance is broken; color tracks M3-chain position instead. The chain crosses bands: qm=1 of band b pairs with qm=2 of band b+1.

If you add a V-like mode in the future, mirror all three. Region info alone isn't enough.

---

## Audio engine

### `commitRampSync` must integrate in-flight ramps before starting new ones

Rapid `sRampFreq` calls (e.g., during fast transposition) will race if the new ramp doesn't first integrate the in-flight ramp's current position into the source anchors. Symptom: voices snap back to old frequencies mid-ramp. Solution: `pendingRamp` identity check; cancel stale re-anchors; position-based wrap check.

### Wrap-aligned segment switching: never use `source.loop = true`

All sample wraps go through `scheduleSegmentSwitch`. Native looping doesn't compose with crossfade scheduling, ramp races, or the `validStartsByEnd` graph. If you find yourself wanting `loop = true`, you're solving the wrong problem.

### Polyphonic aftertouch handover needs velocity anchoring

When the first AT message arrives for a voice, you can't just snap voiceGain to the AT value — you'd discontinuously change loudness mid-note. Solution: store the velocity-implied initial gain at note-on, ramp from current gain to AT-implied target with `AFTERTOUCH_RAMP_S` smoothing.

### Sustain re-articulation requires explicit noteOff

Striking a key that's currently sustained (held only by the pedal) needs `noteOff(key)` to stop the old voice cleanly, then create a fresh voice with the new velocity. Without the explicit noteOff, the old voice continues indefinitely. The flash (`triggerRearticulateFlash` / `rearticulateFlashUntil`) is the visual confirmation that re-articulation happened.

### `ampStepDev` is orthogonal to `xfadeDev`

In the analyzer, two loop points can be phase-coherent (low `xfadeDev`) but volume-mismatched (high `ampStepDev`). Trombone is the canonical case — vibrato keeps phase reasonably aligned but envelope drifts. Both gates must pass to admit an edge in the validStartsByEnd graph. Thresholds: 0.08 for trombone, 0.15 for reed_organ, 0.25 default.

### Soundfont and real-instrument oboe/horn share a single wall

Tested 5 oboe sources (FluidR3, MusyngKite, FatBoy, VSCO-2-CE Sus, SSO peastman) and 3 french horn sources (FluidR3, MusyngKite, FatBoy). All eight failed default analyzer gates with the same `clique filter reduced to 0 pts (picks=N)` pattern, N=2–8.

Root cause: `filterToBackwardClique`'s pre-clique forward-stability prefilter (`fwdStabilityThreshold`, default ±10% RMS dev in 300ms forward window). Brass and double-reed samples — soundfont-rendered or anechoic-studio — carry breath/embouchure micro-variation in the post-onset window. The gate documents this exact case ("Brass onsets are the canonical case…").

Loosening (`fwdStabilityThreshold: 0.4` or higher) admits picks but produces audible boop/swell artifacts at loop seams. Audited MusyngKite oboe at 0.40 (still wobbly) and VSCO-2-CE Sus at default 0.10 (clean analyzer-side, still wobbly to the ear because the anechoic recording exposes every breath inflection). Both confirm the gate's verdict.

**Implication**: oboe and french horn are unattainable through the current macro-period algorithm regardless of source. Proper handling requires envelope slope-matching at the loop seam — currently only done in the `vibrato` path, and only for *periodic* modulation. v1.x algorithm task. See `decisions.md` for the v1 deferral entry.

### Default `gateOpts` are surprising; check the `||0.25` defaults before tuning

`cliqueThreshold` default is **0.25**, NOT 0.97 or any near-1.0 number. Higher values are *looser* (admit more pairs at higher midpoint-RMS deviation); lower values are *tighter*. `reed_organ` uses 0.15 because reed-organ samples are unusually steady, allowing tighter mid-crossfade tolerance.

Misreading the direction once cost an entire oboe iteration: set `cliqueThreshold: 0.15` thinking it was loose, it was tighter than default and failed harder. Always look at the `||0.25` fallback in `filterToBackwardClique` (`analyzer/HexKeyLab-analyzer.html`) before guessing.

Same convention for `fwdStabilityThreshold`: default 0.10 is *strict*; 0.30/0.40 are *looser*; 10 (or `Infinity`) effectively disables.

### Loop pathway needs ≥0.45s steady region (`minBackwardSec` + `minForwardSec`)

Even with permissive clique gates, every viable pick must satisfy `backward seam ≥ minBackwardSec` (default 0.15s) AND have a forward partner `≥ minForwardSec` (default 0.30s) = 0.45s minimum loop pathway.

FluidR3 french horn at loose gates passed the clique filter but failed every sample with `no usable loop pathway: no b has both a clean backward seam (≥0.15s) and a forward partner (≥0.3s)`. Brass samples often have steady regions shorter than 0.45s. Independent of clique-filter quality, not gate-tunable without compromising runtime loop quality (audible repetition at very short loops).

### Analyzer measures actual freq, never trusts source labels

Source-label tuning offsets don't matter to the pipeline. The analyzer's autocorrelation refines the fundamental within a search window seeded by `labeledFreq / cfg.transpose`, then emits `freqActual` as the canonical pitch in samples.ts. Runtime plays at `rate = target / nearest.freq` — labels are not in this path.

Tested:
- SSO peastman oboe (5–15¢ flat per its SFZ tune corrections): autocorrelation finds actual pitch transparently.
- VCSL Renaissance Organ 8' (octave-shifted): with `transpose: 0.5`, autocorrelation searches at 2× label and finds the true fundamental.
- Salamander piano (Railsback +22¢ at top): autocorrelation captures the stretched tuning baked into the recording.

**Implication**: don't disqualify a candidate source for "labels are off" or "tuning is non-standard." The analyzer handles it. The label is only a search seed.

### Iowa MIS (theremin.music.uiowa.edu) has no CORS headers

`Access-Control-Allow-Origin` is not returned for cross-origin requests. Disqualifies it as a direct browser-fetch source. To use Iowa samples in HKL, they must be mirrored to a CORS-friendly location (GitHub raw, our own static host) or transcoded into the repo as binary assets.

---

## Rendering

### Seam endpoints must snap to outline vertices

`snapVtx(px, py)` searches for the nearest outline vertex within 6 pixels. Use vertex search only — no segment projections, no flanking-hex logic. The simpler approach is correct here; cleverness produces visual artifacts at corners.

### Selection highlights live outside the offscreen build

Hex/text canvases are rebuilt on dirty flags (layout extent, septimal shift, note name visibility). Selection state is per-frame because it changes constantly. Don't try to bake selections into the offscreen canvases — the rebuild cost will dominate.

### Layout switches are zero-cost via offset change — BUT ref shifts can exceed the static pad

The offscreen canvases are built at a fixed reference (`gridRef`) with padding covering layout travel distances. A small-range layout shift (e.g. the old ♭/♮/♯ system's `(±7, ∓4)` travel) is just a blit offset; no rebuild.

The ref-driven shift (§ refSpine) can move the view to ANY (q, r) — well beyond the static pad's coverage. For those shifts, `buildHexLayerForTween(startQ, startR, endQ, endR)` is called BEFORE the tween fires; `sizeGridCanvases` then sets `gridRef` at the midpoint of the tween range and adds half the tween distance to the pad. The hex layer covers both endpoints, no cut-off borders mid-tween. Applies to all outline modes (piano has always done this; Lumatone / QWERTY now do too because refSpine can move them anywhere).

If you find yourself debugging "cut-off lattice borders during a tween", check that `buildHexLayerForTween` was called before `tweenTo` for that outline mode. The piano path has had it forever; the Lumatone/QWERTY path was added when ref-driven shifts replaced the 3-layout buttons.

---

## CSS / DOM

### Class sharing across handler types is a footgun

`querySelectorAll('.tpab')` matched both transpose AND seam-shift buttons because both used `.tpab` for styling. Seam-shift buttons lacked `data-dq/data-dr`, so the transpose handler hit `+undefined = NaN`, then `keyFreq(NaN) = NaN`, then `setValueAtTime(NaN, …)` threw. Symptom was a vague audio breakage on seam shift.

**Rule**: when a handler depends on specific attributes, qualify selectors with attribute filters: `.tpab[data-dq]`. Don't rely on the class alone if other elements share it for styling.

### `:has()` is fine to use; we already do

`.ctrls label:has(input){cursor:pointer}` is in the existing CSS. Browser support is universal as of 2024. Don't waste time avoiding it.

---

## SysEx / MIDI plumbing

### CMD 0x3E packets are spontaneous, not ACK responses

Calibration packets from the Lumatone are NOT replies to a sent message; they're emitted automatically every ~100ms while calibration mode is active. The standard ACK-matching logic in `sysexHandleResponse` will silently drop them because there's no waiting message to match against. Route them separately from `handleMidiMessage` BEFORE calling `sysexHandleResponse`.

### `pushSilent` flag separates UI-affecting pushes from control-path pushes

Color sync should show progress in the status badge. Firmware queries and calibration commands shouldn't. Both share the queue infrastructure. The `pushSilent` flag toggles UI updates without forking the queue. When adding a new control-path command, set `pushSilent = true`.

### In-flight messages finish naturally on queue swap

When a new sync starts mid-push, the in-flight message is NOT cancelled. It finishes, ACKs, then the new queue takes over. The `predicted` snapshot folds the in-flight message's intended state into the diff so the new queue accounts for it. Don't try to abort the in-flight message — that creates ACK/timeout races.

---

## Process / workflow

### Stop and ask when hitting circular reasoning

If a problem keeps not yielding to attempts, stop guessing and ask. Examples that should have triggered earlier asks: the descending-once-per-second pedal behavior (turned out to be hardware wiring, not firmware), the band/region distinction in 7-limit (turned out to need careful reading of LTN files). Cheap ask, expensive guess.

### Run `npm run typecheck` and `npm run build` before claiming a change works

Cheap, deterministic, catches the regression before Max does. The build also surfaces import-resolution failures that strict TypeScript alone misses.

### Re-Read files between edits when other tool calls may have modified them

If `Edit` fails with "file modified since read", re-Read the file and re-attempt the same change before moving on. Skipping the re-Read is how silent edit losses happen — the failure looks final but isn't.

### Design before code on complex features

For anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems: propose the design first. Simple tweaks can be implemented directly. The cost of reverting a wrong implementation is much higher than the cost of a design discussion.

### Refactor, don't rewrite

The audio engine especially has subtle, well-tested behavior (segment switching, ramp races, sustain semantics) that's expensive to reproduce. Move things between modules, add types, but don't redesign internals. Mixing mechanical refactor with internal redesign is the standard rewrite-doom failure mode.

---

## Architectural decisions

Settled choices that shouldn't be re-litigated without a strong new reason. Recorded here so that future sessions don't waste cycles re-evaluating them. (For decisions made *during* the v0.9→v1.0 migration, see `decisions.md`.)

### Single static Lumatone mapping; HKL interprets layout in software

**Old approach** (deprecated): three LTN files (`5_limit_natural.ltn`, `5_limit_flat.ltn`, `5_limit_sharp.ltn`) each encoding a different MIDI mapping for the same physical keys, plus a shared SCL/KBM tuning loaded into Surge XT. Layout switches required swapping the LTN file in the Lumatone Editor; tuning lived externally in Surge.

**Current approach**: one static LTN file configures the Lumatone with a fixed (channel, note) address per physical key. HKL receives MIDI from the Lumatone, maps the address to a lattice position based on the current layout, computes the frequency from the active tuning system, and renders audio directly. Layout switching is pure software state in HKL.

**Why we changed it**:
- Layout switching at the Editor level was a workflow break — physical interaction with a laptop mid-session
- Tuning and layout were coupled across two tools (Lumatone Editor + Surge), creating sync hazards
- The SCL format couldn't represent 7-limit's full pitch space (118 unique pitches > 79-note SCL ceiling), forcing compromises
- Once HKL had its own audio engine, going through an external synth was redundant signal path
- One static Lumatone configuration is one less thing to keep in sync across machines

**Implications for new code**:
- HKL is the synth. Don't add code paths assuming an external synth will receive MIDI.
- The fixed MIDI layout is the only Lumatone addressing scheme. Don't add per-layout MIDI mappings.
- Tuning math runs at HKL runtime, not at LTN-build time.

---

## Stereo-to-mono downmix conventions disagree by 3 dB

ffmpeg's `-ac 1` and Web Audio's `AnalyserNode` (default `channelInterpretation = "speakers"`) use *different* downmix formulas, and they disagree by exactly 3 dB on mono content packed into a stereo container:

- **ffmpeg `-ac 1`**: energy-preserving, effectively `(L+R)/sqrt(2)`. For correlated channels (mono content), RMS is `sqrt(2) * per_channel_rms` = +3 dB above either channel alone.
- **Web Audio AnalyserNode "speakers" downmix**: amplitude-averaging, `0.5 * (L+R)`. For correlated channels, RMS = `per_channel_rms`.

Most CDN instrument samples (FluidR3, FatBoy, Salamander) are mono recordings packed into stereo MP3s. The two channels are nearly identical, so this 3 dB gap shows up directly: the analyzer's measured RMS is +3 dB above what `loopOverlay` would have read with the default single-tap AnalyserNode setup. Symptom we hit: `loopOverlay` was reading 3 dB low across every instrument vs. the analyzer's normalization target.

Fix in `src/audio/diagnostics/loopOverlay.ts`: tap `sampleMaster` into a `ChannelSplitter`, give each channel its own AnalyserNode, and combine via energy-summed RMS (`sqrt(rmsL^2 + rmsR^2)`) in `tick()`. This matches ffmpeg's downmix and the LUFS / ITU-R BS.1770 channel-summation convention, both of which approximate perceived loudness rather than amplitude average.

Lesson: when normalizing audio levels, the measurement convention is half the answer. Always check that your analyzer and your meter agree on what "the level" means, especially for stereo content.

---

## Recording / MIDI

### Capture point is the audio engine, not the MIDI handler

The "post-MIDI-translation" framing for the recording capture point is right in spirit (record `(q, r)`, not `(channel, note)`) but the actual implementation should hook one step further downstream: inside `audio.noteOn`/`noteOff`/`handleAftertouch`/`setDamperDepth`/`sostenuto*`. The audio engine is the convergence point for every input source — Lumatone, QWERTY, mouse-click — and any future input source will pass through it too. Hooking at `midi/handler.ts` after `fixedMidiToKey` would silently drop QWERTY and click input from recordings. Hooks short-circuit when `isRecording()` is false; cost is essentially zero when idle.

### Splitting modules to break import cycles beats dynamic imports

`recording/snapshot.ts` originally contained both `captureSnapshot` (used by `capture.ts`, hence `audio/engine.ts`) and `applySnapshot` (used by `ui/recorder.ts`, which calls `ui/controls.ts`, which transitively re-enters `audio/engine.ts` and back into `recording/capture.ts`). The cycle was broken with dynamic `await import('../ui/controls.js')` inside `applySnapshot`. It worked, but Vite emitted chunking warnings and the indirection was hard to follow.

Fix: split into `snapshot.ts` (leaf, read-side: `captureSnapshot`, `snapshotMatchesLive`) and `apply.ts` (write-side: `applySnapshot`, imports `ui/controls.ts` statically). The split lets `recording/snapshot.ts` stay leaf-position, which is what makes the engine-side hook chain clean. Module-graph hygiene is worth a small file split.

### Dynamic-import `.ts` and `.js` URLs give different module instances

`await import('../foo.ts')` and `await import('../foo.js')` resolve to the SAME source file under Vite's TypeScript→JS transform, but the module registry caches them under their literal specifier strings. Two dynamic imports with different extensions yield two distinct module instances with independent module-level state. State you mutate in one is invisible to the other.

Surfaces when refactoring an inline initializer into a dynamic-import-bound module setter: code path A imports `'foo.js'` (static), code path B imports `'foo.ts'` (dynamic), they see different `tuning` / `selection` / etc. exports. Workaround we used in the 7-limit revamp: prefer plain dropdown change events (which call the same statically-imported module everyone else uses) over dynamic-import state mutation. Don't mix extensions across dynamic and static import call sites.

### Voice migration: physical inputs follow the lattice, mouse clicks anchor

When the lattice shifts under the outline (refSpine ref change, layout change in the old system, etc.), voices originating from PHYSICAL inputs migrate with the shift. Mouse-click voices stay where they were clicked.

The distinction is input identity: a Lumatone key has a persistent `(ch, note)` identity that survives the lattice shift; the user is still pressing the same physical key, so they expect the same physical-key-relative pitch. Same for QWERTY (`e.code` is the identity). A mouse click is one-shot — the click event has no identity beyond the lattice cell it produced.

If you migrate clicks too, you have to invent a synthetic identity for them ("phantom click on cell X moves to cell Y"), which doesn't match anything the user actually did. If you don't migrate physical inputs, held chords on the Lumatone jump pitches mid-press when the ref shifts.

The fan-out in `src/effects/onRefChanged.ts` calls `migrateHeldQwertyVoices(dq, dr)` + `migrateHeldLumatoneVoices(dq, dr)` + `buildMidiReverse()` AFTER the ref mutation, with the spine delta. Each input source maintains its own held-voice tracker (`heldCodes` for QWERTY, `heldLumatonePhys` for Lumatone) because the identity shape differs per source.

### Outline polygon stays static; the lattice slides

The Lumatone/QWERTY/none outline polygons are precomputed from `baseKeys` and `qwertyKeys` at fixed lattice coords. They never translate on screen. The lattice cells underneath them translate when refSpine changes.

Canvas bounds depend on the outline's pixel extent, NOT on refSpine's possible range. The ref-driven shift adds zero bounds dependency. If you find yourself recomputing canvas bounds on ref change for a non-piano outline, you're doing something wrong — the outline is visually static.

Piano outline is the exception: it's computed per-ref via `compute88PianoCoords` and IS recomputed on ref change.

### `midi-file` library conventions: pitch bend is signed, channel is 0-indexed

The `midi-file` npm package uses two conventions that bite if you don't read its source:

- **Pitch bend value is signed in [-8192, +8191]**, not unsigned 14-bit. The writer adds 0x2000 internally. So pass `bend14 - 8192` when constructing a pitchBend event, where `bend14 ∈ [0, 16383]` is the raw 14-bit value.
- **Channel field is 0-indexed**. MIDI channel 1 (the MPE manager) is `channel: 0`; channels 2–16 (MPE members) are `channel: 1` through `channel: 15`. Easy to off-by-one because the SysEx/MPE specs talk in 1-indexed terms.

Both verified in the package's `lib/midi-writer.js` and `lib/midi-parser.js`. Worth keeping the conversion explicit at the boundary (e.g., the `MpeAllocator` returns 1-indexed channels and `export.ts` subtracts 1 at the write call).

### MPE pitch-bend range must precede the first note-on per channel

MPE export emits pitch bend BEFORE noteOn for every voice event, not just at the start. Reason: per-channel RPN bend range = 48 semitones is set in the t=0 preamble, but each subsequent note-on on that channel needs a fresh pitch-bend value because the previous voice's bend is still latched. The stable-sort `(t, ord)` in `export.ts` preserves the pitchBend-before-noteOn invariant within a single timestamp window — don't reorder events by note number or channel inside a tick.

### Web Audio's `audioCtx.currentTime` keeps ticking even when the context is suspended

Used as the timestamp source for recording (via `clock.ts:nowSec()`) so recorded times align with what the engine ramps schedule against. The clock advances monotonically regardless of `suspend()`/`resume()` calls — which is correct for recording, but worth knowing if you ever read `currentTime` thinking it pauses with audio playback. It doesn't.

### Recording capture short-circuits when audio is disabled — by design

Capture hooks live inside `audio.noteOn`/`noteOff`, which both early-return when `audio.audioEnabled === false`. So pure-selection clicks (no sound) don't record. This is intentional: recording without audio is meaningless. Documented in `src/recording/capture.ts` and surfaced in the UI as "Enable Audio first" when the user clicks Record with audio off.

### Sample normalization can't fix source-level mismatch when the peak ceiling is tight

The decay-path gain normalizer (now K-weighted LUFS via `analyzer/k-weighting.js`) targets a fixed RMS-equivalent loudness with a −3 dBFS per-sample peak ceiling. When a source's individual samples already sit near that ceiling — Maestro grand piano is the prompting case, many of its notes peak at −3 dBFS direct from the recording — the peak ceiling clamps the gain before RMS-targeting completes. Adjacent notes with matched peaks but different sustained loudness will then play back at different integrated LUFS levels, despite the normalizer's best effort.

K-weighting reduces the mismatch (Maestro: ~8 dB → ~3–4 dB across the keyboard) but doesn't eliminate it. Iowa piano, which is recorded with substantial headroom, normalizes cleanly to within ~0.5 dB.

Diagnostic: if `analyzer/out/<key>-report.md` shows a `Peak (dBFS)` column clustered at −3 with non-uniform LUFS, the peak ceiling is binding. The fix isn't a different normalizer — it's a better-mastered source recording. Don't reach for the headroom by raising `TARGET_PEAK_DBFS` (allows single-note clipping) or lowering `TARGET_DBFS` (makes the whole instrument quiet relative to others).

## Composer / Verovio / engraving

### Verovio's `svgViewBox: true` is what makes the SVG scale to its container

The most important fact about Verovio's `svgViewBox` option, learned the hard way:

- **`svgViewBox: true`** → emitted SVG carries only `viewBox`, no intrinsic `width`/`height`. Browser scales the SVG to fill its containing block's width while preserving aspect ratio. Rendered staff size depends on the viewport width.
- **`svgViewBox: false`** (or omitted) → emitted SVG has explicit `width="X" height="Y"` pixel attributes. Browser renders at exactly those dimensions, no scaling. Container scrollbars handle overflow.

For an editor where staff lines need to land on stable pixels regardless of viewport, you want it OFF. For a "fit the score to whatever width is available" viewer, you want it ON. We tried both during the HKL Composer launch; OFF was the right call for live editing.

Knock-on effect: with `svgViewBox: false`, the SVG's intrinsic size = `pageWidth × scale/100` by `pageHeight × scale/100`. So `scale` is a true zoom on output dimensions, and `pageWidth` directly controls the canvas pixel width. With `svgViewBox: true`, `scale` only affects internal coordinate density, which browsers normalize away during fit-to-container — the visible size doesn't change with `scale` adjustments. This led to "scale doesn't do anything" confusion across several iterations.

### Verovio justifies content to `pageWidth` when `breaks: 'none'`

With `breaks: 'none'` and a `pageWidth: 100000`, a single measure of content gets stretched across 100000 tenths of canvas. The justified content + `svgViewBox: true`'s browser scaling = one measure across the entire viewport. The fix isn't to make pageWidth small (then content overflows / clips); it's to drop `svgViewBox` so the SVG renders at intrinsic pixel size and the user scrolls horizontally through the natural-width content.

For scroll-style mode: `breaks: 'none'`, `pageWidth: 100000` (Verovio clips the emitted SVG width to the actual content extent, so a huge pageWidth is fine — it just gives layout headroom), `svgViewBox: false`, `scale: 100`.

### Staff line spacing must be an integer multiple of the output pixel density for crisp lines

At Verovio's default `unit: 9` and `scale: 50`, staff space = 4.5 px (non-integer). Every other staff line falls on a half-pixel y-coordinate; `shape-rendering: crispEdges` rounds those inconsistently → 1px/2px alternation across the five staff lines.

Fix: pick `unit × scale/100` to land on an integer. At `scale: 50`, `unit: 8` gives 4 px between lines. At `scale: 100`, `unit: 9` (default) gives 9 px (integer) — also crisp.

Apply `shape-rendering: crispEdges` via CSS only to linear elements (`.staff path`, `.barLine path`, `.stem rect`, `.ledgerLines path`). Notehead and accidental glyphs are SMuFL font outlines rendered via `<use>` — they need `geometricPrecision` (the default) for shape quality. Applying `crispEdges` globally makes glyphs blocky.

### Frescobaldi does not auto-reload changed files; LilyPond compile is too slow for live preview

Researched during the HKL Composer pivot. Frescobaldi (Wilbert Berendsen, active but slow, latest 4.0.4 Aug 2025) has no documented `QFileSystemWatcher` integration. External writes to an open `.ly` file are either silently ignored or show a Qt "file changed on disk" prompt at focus-in — neither produces a live update.

LilyPond binary compile times are ~1–3 s on small scores (Guile startup dominates even on empty input). Not "live" by keystroke standards.

`frescobaldi --line=N --column=M file.ly` does drive the cursor in a running single-instance Frescobaldi, but only the text cursor, not the PDF preview. PDF-side highlighting from outside isn't exposed.

Net: Frescobaldi is a great editor for hand-tweaking `.ly` source, but cannot serve as a live preview surface for a streamed-write workflow. HKL Composer uses Verovio in-app for live; the `.hkr` → LilyPond transcription path writes `.ly` files for users to open in Frescobaldi when they want text-level polish on a finished score.

### Stale DOM refs across `innerHTML` rewrites are the most insidious overlay bug

The HKL Composer cursor disappeared after the first user interaction. Trace: `cursor.attach()` set `this.svg = newOverlay` but `ensureNodes()` checked `if (!this.barRect)` — the ref still pointed to the previous overlay's `<rect>` (which had just been GC-eligible because Verovio's `loadData() + renderToSVG()` wrote a fresh `innerHTML` on `#score`, destroying the previous overlay along with the Verovio SVG). The check evaluated falsy and the new overlay never got its `<rect>` appended. Subsequent attribute writes went into the orphan node.

Lesson: any code that caches references to DOM elements inside a container whose `innerHTML` is rewritten externally must reset those refs at the rewrite boundary. The cleanup belongs in the function that handles the rewrite (here, `cursor.attach()`), not in the next-frame logic.

Sister pitfall on the same overlay: if you also override the overlay's width/height in `attach()` to a fixed value (e.g. `100%`), you fight the caller's careful work to size the overlay to match the underlying SVG's pixel dimensions — and the overlay's coordinate system stops aligning with the content. Either size from the caller or size in attach, not both.

### BroadcastChannel feedback loops require explicit suppression

HKL Composer dispatches `play-score` to HKL via the bridge. HKL plays via its audio engine — which adds the playing keys to `selection.selectedKeys` so they highlight on the lattice via the existing `draw()` path. But HKL's bridge also broadcasts `held-keys` whenever `selectedKeys` changes — so Composer would see its own playback as held-key input, treat them as candidate notes for the next duration-key entry, and loop.

Fix: `playbackActive` boolean in `src/bridge/hkl-side.ts`. Set true at play-chord / play-score start; false at finish / abort. While true, `broadcastHeldKeysIfChanged()` returns early. Composer's view of held-keys is unchanged from before playback; when playback ends, the broadcast picks up the real selectedKeys delta.

Sister tracker: `playbackOwnedKeys: Set<KeyId>` to record which selectedKeys entries were added BY playback dispatch (vs. keys the user was already holding via mouse/Lumatone). The noteOff path only removes keys that playback owns — so user-held keys survive a playback that happens to play the same coord.

### MEI's `@color` attribute paints the entire note tree by default

Setting `<note color="#abc">` in MEI propagates the color to descendants in Verovio's SVG output: notehead, stem, flag, accidental, even the dot. To color only the notehead, we override stem/flag/accid back to black via CSS `!important`:

```css
#score svg .stem, #score svg .stem *,
#score svg .flag, #score svg .flag *,
#score svg .accid, #score svg .accid *,
#score svg .ledgerLines, #score svg .ledgerLines *
  { color: #000 !important; fill: #000 !important }
```

Both `color` and `fill` need !importanting because Verovio uses CSS `color: ...` on the group with `fill: currentColor` on children (and occasionally direct `fill` on others). The cascade is finicky; targeting the descendants and forcing both properties is the reliable path.

### Verovio's `edit()` API is experimental and supports only `drag`/`insert`

Looked at this during planning. Documented at book.verovio.org as "experimental code not to rely on." Only two action types in the codebase. No high-level operations like "change pitch", "add note to chord", "change duration", "insert measure", "change time signature".

Implication: a Verovio-based editor maintains MEI in its own model layer, mutates the XML/DOM directly, and calls `tk.loadData(newMei) + tk.renderToSVG(1)` to refresh. Verovio is the engraver, not the editor. HKL Composer's `src/composer/model.ts` is the editor.

### Verovio's `@accid="ss"` renders ## (two single sharps), `@accid="x"` renders × (canonical double sharp)

Both are valid MEI 5 double-sharp tokens but they map to different SMuFL glyphs:
- `ss` → U+E269 `accidentalSharpSharp` (precomposed `##`).
- `x`  → U+E263 `accidentalDoubleSharp` (the canonical × croix).

HKL Composer wants `x` for the conventional appearance. `replaceDocument` migrates legacy `@accid="ss"` to `x` on load. Triple-sharp is `ts` (U+E265, Verovio renders it visually as `×♯`); triple-flat is `tf`. Double-flat has no equivalent confusion — `ff` is canonical.

### Verovio's multi-`<accid>` children overlap exactly — no horizontal layout allocation

MEI 5 explicitly allows multiple `<accid>` children on a single `<note>` for compound alterations (quadruple-sharp etc.). Verovio source has comments like `// Reduce spacing for successive accidentals` in `AdjustAccidXFunctor`, suggesting it handles the case. **It doesn't, in practice** — verified by headless inspection: two `<accid accid="x"/>` children rendered both at viewport left=164.6 right=183.1, identical bbox, total overlap.

Implication: HKL Composer can't faithfully render `|alter| > 3`. Choices were (a) hand-position glyphs and reserve layout space (would require patching Verovio or doing complex SVG post-processing), or (b) clamp at ±3 and filter higher-alter input. Picked (b); the lattice positions that produce ±4+ are extreme enough that the user can re-spell by transposing.

### `@tie="ti"` / `"it"` is not a valid MEI 5 value

We initially merged tie flags into compound forms when a note was both medial-terminus and medial-initial in a chain. Verovio rejects: `Unsupported data.TIE 'ti'`. MEI 5's `data.TIE` enum is `i | m | t | n` — `m` already means "medial" (both incoming and outgoing). Always use `m` for medial pieces.

### Verovio renders `<tie>` / `<lv>` only when both endpoints resolve

Verovio's `<lv>` (laissez vibrer) inherits from `Tie` and goes through `View::DrawTimeSpanningElement` → `HasValidTimeSpanningOrder`, which returns false if `start` OR `end` is null. With only `@startid` (no `@endid`, no `@tstamp2`), the element renders nothing silently — no warning, no glyph.

MEI 5's spec says `<lv startid="#x"/>` alone is valid (only one of startid/tstamp.* required), but Verovio implements the older MEI 4 stricter rule (`one of {dur, dur.ges, endid, tstamp2}` also required). `@dur` is NOT consulted; only `@endid` or `@tstamp2` create the second endpoint. For HKL Composer stub ties, we ended up using `data-pending-tie="true"` as a private flag (no Verovio rendering at all, just auto-resolution into a real `@tie` pair when a partner appears).

### Verovio's "Unable to match @tie of note" warning vs "Expected median or terminal"

Two distinct Verovio messages on the same family of problem:
- **"Expected median or terminal in note '%s', skipping it"** (`src/convertfunctor.cpp:1204`): fired during analytical `@tie` → `<tie>` element conversion when a same-pitch follower lacks an expected `@tie="m"` or `@tie="t"`.
- **"Unable to match @tie of note (n), skipping it"**: lives in the compiled WASM (verified via `strings`) but is harder to locate in source. Fires under related conditions when the tie pair-up fails.

When you see either, root cause is usually a stale `@tie="i"` on a note whose downstream partner has been removed (auto-tie chain orphaning bug) or where compound `"ti"`/`"it"` slipped in. The fix is `orphanTiePartners()` on every removal path + single-letter `@tie` values only.

### Manually-set xml:id without setAttributeNS

`element.setAttribute('xml:id', 'foo')` stores the attribute with local name literally `"xml:id"` in the NULL namespace. Subsequent `element.getAttribute('xml:id')` works (qualified-name lookup), but `querySelector('[*|id="foo"]')` does NOT match (`*|id` matches local name `"id"` in any namespace, not `"xml:id"` in null namespace).

For HKL Composer, this hid a bug in tie-partner cleanup: the partner lookup used `querySelector('[*|id="…"]')` and silently returned null for any element whose xml:id was set via the wrong API.

Fix: always use `element.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', value)`. The `el()` helper in `model.ts` has a special case for the `xml:id` key.

### `Document.getElementById` doesn't see `xml:id` in XML-parsed docs

Even when `xml:id` is set correctly (via `setAttributeNS` in the XML namespace), `Document.getElementById('foo')` on a doc parsed with `DOMParser.parseFromString(s, 'application/xml')` returns `null`. `getElementById` only recognizes attributes declared as ID type in a DTD — `xml:id` doesn't count without explicit DTD support, which our MEI docs lack.

This bit the per-note tie playback fix: the `data-tie-partner` chain walker used `mei.getElementById(partnerId)` which silently returned null, so partial-tie chords were never coalesced and the all-tied case lost its extended duration.

Fix: build a `Map<string, Element>` index over `mei.getElementsByTagName('note')` keyed by `getAttribute('xml:id')`, or use `querySelector('[xml\\:id="…"]')` (note the escaped colon). For repeated lookups, the map is faster and clearer.

### Save → load round-trip with the accidental-display pass

The display pass runs on the SERIALIZE clone, not the live doc. Output MEI has `@accid.ges` for hidden notes (and `@accid` for visible ones). On load, the live doc has whichever form was saved.

If the display pass on the next render only reads `@accid` (and not `@accid.ges`), a previously-hidden sharp would be misread as natural and the pass would spuriously emit `@accid="n"` to "cancel" a non-existent prior sharp. The fallback in `accidentals.ts:getNoteAlter`:

```ts
const a = note.getAttribute('accid');
if (a !== null) return alterFromToken(a);
const g = note.getAttribute('accid.ges');
if (g !== null) return alterFromToken(g);
return 0;
```

…makes the round-trip idempotent. The same falls-through-to-ges pattern must exist in any code that derives pitch from a note — save.ts, model.ts's `extractResolvedFromElement`, etc.

### Verovio renders `<space>` as a 0×0 invisible group; `<mSpace>` doesn't reserve width

For HKL Composer empty-voice layout, we want a layer with no real content to still take up its measure's full horizontal space (so the bar line aligns with the staff lines). Three candidates were tested via headless:
- `<mSpace/>`: marker for "tacit measure". **No effect on layout.** Same bar-gap as truly-empty.
- `<rest dur="1"/>` (whole rest): proper width allocation, but draws a visible rest glyph (and `@visible="false"` is NOT honored by Verovio).
- `<space dur="1"/>`: proper width allocation, draws nothing. **The winner.**

`<space>` requires `@dur` — without it, behavior is undefined per spec and Verovio doesn't allocate width. For irregular meters (5/4 etc.), use `decomposeTicks(measureTicks)` to express the duration as one or more `<space>` children whose ticks sum to one measure.

The rendered `<g class="space">` has degenerate bbox (left=30 width=0 in our SVG coordinate space), so the cursor overlay falls back to staff-anchored positioning when its target is a placeholder.

### Verovio's "play-chord" entry-time monitor cuts held Lumatone notes short

Original design: on each duration keypress, Composer sent `play-chord` to HKL with the entered notes + a calculated duration in ms. HKL would `noteOn` + scheduled `noteOff`. Problem: the user is still holding the Lumatone keys for those notes. HKL's scheduled `noteOff` fires after the calculated duration and CANCELS the user's held note (their physical key press → MIDI → noteOn registered the note; HKL has no way to distinguish "released by user" from "scheduled noteOff timer"). Result: notes drop out mid-hold.

Removed entirely. Composer only sends playback during explicit `play-score` (Play button). For audible feedback during entry, the user already hears their held Lumatone keys live via HKL's regular audio path.

### Sub-pixel stroke widths and `crispEdges` / `geometricPrecision`

Verovio emits stems with `stroke-width="18"` in internal coordinates, which at our scale comes out to ~1.8 viewport pixels. With `shape-rendering: crispEdges`, that gets snapped to either 1 or 2 pixels depending on the stroke's sub-pixel x-position parity. The same applies to bar lines (`stroke-width=27` ≈ 2.7 px) and any horizontally-positioned stroke.

`shape-rendering: geometricPrecision` anti-aliases instead — every stroke renders to the same visual weight regardless of position. Also degrades gracefully at high zoom-out: a 1-px line that `crispEdges` would round to 0 (invisible) stays visibly faint with `geometricPrecision`. HKL Composer uses `geometricPrecision` on staff lines, ledger lines, bar lines, and stems — everything that's a `<path>` stroke. SMuFL glyphs (notehead, accidental, etc.) keep the default rendering since they're filled `<use>` references, not strokes.

### Expression-layer tstamp anchoring trade-off

Dynamics and hairpins anchor by `@tstamp` (and `@tstamp2`) instead of `@startid`/`@endid` (see decisions.md). Slurs and articulations stay note-attached. Different anchoring rules for different element classes is intentional — the semantics differ (time-anchored vs note-anchored).

**Watch for**: a meter change with `setTimeSig` does NOT migrate tstamp positions. A dynam at `tstamp="3.5"` in 4/4 stays at `tstamp="3.5"` after switching to 3/4 — which is now past the bar line. Verovio handles this gracefully (the dynam either disappears or wraps depending on version), but the user's intent is lost. If this becomes a real source of confusion, add a `truncateOrMigrateExpressions(prevMeter, newMeter)` pass alongside `truncateOverflowingMeasures` that either drops out-of-range expressions or wraps them into the next measure. The infrastructure (`expressionMoments`, `formatTstamp2`) is in place — only the migration policy needs deciding.

### Verovio doesn't honor `@visible="false"` on rests; `<space>` doesn't trigger the tuplet bracket

For invisible tuplet placeholders we wanted "rest that takes layout width but draws no glyph AND counts as content so Verovio renders the bracket over it". MEI's spec-correct form is `<rest visible="false">` — but Verovio doesn't implement `@visible` (issue rism-digital/verovio#202 from 2016, still open as of v6.1). Set it on a rest, the glyph still draws.

The other MEI invisible-rest form is `<space>` — but Verovio's tuplet-bracket-rendering pass only fires when the tuplet contains "content" children (notes/chords/rests). `<space>` is layout-only and excluded; an all-`<space>` tuplet renders no bracket.

Workaround used in HKL Composer: tuplet placeholders are real `<rest>` elements marked with `data-tuplet-placeholder="true"`. Verovio draws the bracket because they're rests; the rest glyph is hidden in CSS:

```css
#score svg g.rest[data-data-tuplet-placeholder="true"] { visibility: hidden }
```

`visibility: hidden` preserves the layout slot (so the bracket spans the right range); `display: none` would collapse it. See the next entry for the `data-data-` prefix.

### Verovio's `svgAdditionalAttribute` always prepends `data-` to attribute names

The option is `svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'rest@data-tuplet-placeholder']`. Verovio reads each entry as `element@attribute` and copies the named MEI attribute onto the rendered `<g>` group. But it ALWAYS prepends `data-` to the SVG output attribute name — `data-q` becomes `data-data-q`, `color` becomes `data-color`, etc.

For HKL Composer's CSS selector hiding tuplet placeholder rest glyphs: the MEI attribute is `data-tuplet-placeholder`, the SVG attribute is `data-data-tuplet-placeholder`. The CSS targets the double-prefixed form. Internal HKL code that reads from the MEI doc (not the SVG) uses the single-prefix MEI form — only CSS / SVG-selecting code sees the double prefix.

### `TICK_TABLE` decomposition entries were wrong for dotted/double-dotted ranks

`src/composer/model.ts`'s `TICK_TABLE` is the greedy-decomposition lookup used by `decomposeTicks(n)`. Original entries had dur values off by one rank for the dotted/double-dotted rows — e.g. `{ ticks: 24, dur: '2', dots: 1 }` claimed "24 ticks = dotted half", but dotted half is actually 48 ticks (dotted quarter = 24). The dur values for ticks `{56, 48, 28, 24, 14, 12, 7, 6, 3}` were all one rank too coarse.

This was latent in the existing code because the only consumer was the cross-measure split logic in `insertWithSplit`, which is rarely exercised (user typically enters notes left-to-right without overflow). Tuplet placeholder regeneration via `decomposeTicks` surfaced it — fill+delete should yield a dotted-quarter placeholder for 24 written ticks, but the buggy table emitted a dotted half (48 ticks claimed; the live MEI then had a 48-tick rest representing a 24-tick budget, which is incoherent).

Fix: lines 127-142 of model.ts. Every value in the table now satisfies `ticksOf(dur, dots) === ticks` so `decomposeTicks` and `ticksOf` are mutually consistent. Anything that calls `decomposeTicks(n)` on a non-pow2 tick count benefits from the fix.

### Cursor stop semantics: forward-facing locator vs backward-facing user-perceived target

`locateCursor(v, c)` in `model.ts` is FORWARD-facing — it returns information based on `flat[c]` (the next element after the cursor's logical position). This is correct for INSERTION (the new element goes BEFORE `flat[c]`).

But the user-perceived "current note" in insert mode is BACKWARD-facing — `getCurrentElement(voice, 'insert')` returns `flat[c-1]` (the previous element). This is what dots/ties/Backspace operate on. Visually, the cursor anchors at `flat[c-1]`'s right edge.

The two perspectives mostly agree, but they diverge at element boundaries inside compound containers like `<tuplet>`. With an iter3 "between rule" (we tried it first), the cursor at "before F1 of a tuplet" was reinterpreted as layer-level "before tuplet" so insertions wouldn't false-fire as in-tuplet inserts. But that hid the legitimate "before F1 inside tuplet" position the user needs for prepending into the tuplet. The iter4 fix is to give every user-intent position a distinct flat-index: the tuplet wrapper itself is added to `navigableChildren` as a layer-level stop, separate from its in-tuplet stops. Cursor "before tuplet at layer level" (flat[c]=tuplet wrapper) and cursor "before F1 inside tuplet" (flat[c]=F1, flat[c-1]=tuplet wrapper) are now two adjacent flat-indices at the same visual x — and `locateCursor`'s forward-facing rule naturally distinguishes them.

Takeaway: if your cursor model has compound containers (tuplets, beams, repetitions), the flat-index list must expose ALL boundary positions, not just element positions. The default "before each element" cursor stops handle the simple case; container boundaries need explicit pseudo-stops (in our case, the wrapper itself is also a stop).

### `<dynam>` / `<hairpin>` insertion order in `<measure>` doesn't matter for Verovio rendering

I put expression elements as the LAST children of their `<measure>` (after both `<staff>`s and any `<lv>` stub-tie elements). Verovio doesn't care about MEI element order within a measure — it reads the control events by their `@tstamp`/`@tstamp2` and lays them out in time-order regardless of XML position. This mirrors the existing `<lv>` placement convention (lv elements also appended after the staffs).

If you ever need to query "all expressions in document order", do it by walking the measures first and then their `<dynam>`/`<hairpin>` children — not by DOM-order across the whole `<section>`, since `<measure>`s come in document order but their inner children don't have a meaningful order.

## LilyPond transcription quantization

### `TIE_COST` calibration matters more than `BOUNDARY_WEIGHT`

The duration Viterbi DP in `src/transcription/quantize.ts` balances three costs: atom complexity, ties (cost per non-final atom in a chain), and boundary penalty (crossing a stronger metric position). At `TIE_COST: 0.15`, the DP fragmented well-aligned durations: a 3-beat rest at bar start preferred `r4 r2` (cost 0.20) over `r2.` (cost 0.35). At `TIE_COST: 0.40` the dotted-half wins (cost 0.35 vs 0.45).

The ranking under-the-hood:
- 3-beat rest at bar start, dotted-half: complexity 0.35, boundary 0, ties 0 → total 0.35.
- 3-beat rest at bar start, quarter+half: complexity 0.05, boundary 0, ties 0.40 → total 0.45.
- 3-beat rest at beat 2 of 4/4, dotted-half: complexity 0.35, boundary `(50-25)*0.05 = 1.25` (crosses bar middle, weight 50) → total 1.60.
- 3-beat rest at beat 2, quarter+half: complexity 0.05, ties 0.40, boundary 0 → total 0.45.

Both "starts on beat 1" and "starts on beat 2" produce idiomatic notation. With TIE_COST too low (0.15), the beat-1 case wrongly fragments; with TIE_COST too high (0.60+), ties stop winning when they should (e.g., half note from beat 2 in 4/4 should be quarter+quarter tied, not single half).

### Lumatone has TWO velocity tables, not one

The firmware splits velocity processing into two independent SysEx-controllable tables:

- **CMD `0x08 SET_VELOCITY_CONFIG`** — 128 × 7-bit. **Output relabeling**: bin index N → MIDI velocity. HKL has always pushed identity here. The factory default (Terpstra's "EmptyVelocityCurveTable") is identity 0,1,2,…,127.
- **CMD `0x20 SET_VELOCITY_INTERVALS`** — 127 × 12-bit. **Press-time bin boundaries**: tick-count thresholds that determine which press-time ranges merge into which bin. Factory default has fine granularity at fast presses (1, 2, 3, …, 58) and accelerates at slow presses (170, 175, …, 310).

The two are entirely independent. External software (HKL, a DAW) can replicate CMD 0x08 by leaving the firmware LUT at identity and shaping its own MIDI velocity — *but it cannot replicate CMD 0x20*. By the time MIDI velocity reaches the host, the firmware has already binned press_time and the high-precision information is gone. CMD 0x20 is therefore the only lever that can increase the number of distinct velocities a given keyboard can physically emit.

The wire format for CMD 0x20 splits each 12-bit value into two 6-bit nibbles, totaling 254 payload bytes. Natural order on the wire (no reversal — unlike 0x08).

Sources: `/home/max/TerpstraSysEx.2014/Source/TerpstraMidiDriver.cpp:366–380` (sendVelocityIntervalConfig), `KeyboardDataStructure.cpp:49` (DefaultVelocityIntervalTable).

### Lumatone velocity pipeline: PIC measures, BBB binarises + relabels

(Corrects an earlier-and-now-deleted lesson that claimed the BBB was a pure MIDI proxy.)

The architecture, verified by disassembling `/home/max/lumatone/TerpstraController/TerpstraController` (offsets `0x11d30 binary_search`, `0x11e78 SendMidiKeyStroke`, `0x9c84 decodePicMessage`, `0x15f00 setMyVelocityInterval`):

1. **PIC** (5 per-board microcontrollers) measures press-time as a 12-bit tick count and emits a UART message `[0x30, cmd, key, hi_byte, lo_nibble_byte, 0xFF]` to the BBB. `press_time = (hi_byte << 4) | (lo_nibble_byte & 0x0F)`.
2. **BBB** (`TerpstraController`) decodes the message, then in `SendMidiKeyStroke`:
   - Runs `binary_search(myVelocityInterval, press_time, 0, 126)` → bin index 0..127.
   - Reads `myVelocityTable[bin]` → MIDI velocity 0..127.
   - Looks up per-key channel/note from `kbd_preset_params` (per-board × 638-byte stride).
   - Sends the 3-byte MIDI message via `writeToMidi`.
3. **Host** (HKL) receives the final 3-byte MIDI note-on.

So `myVelocityInterval` (CMD 0x20, 127 × 12-bit) and `myVelocityTable` (CMD 0x08, 128 × 7-bit) live on the **BBB**, not the PIC. They're consumed at runtime by every keypress. We have full read/write access via `/proc/<pid>/mem` and full edit power via the documented SysEx commands.

Implications:
- **Press-time precision is integer-tick** (12-bit, 0..4095) — the PIC's timer resolution. Anything finer is unreachable.
- **The BBB's `binary_search` semantics matter**: on a threshold table with duplicate values, it returns one specific bin (the bisection-tree midpoint where the exact match is found), not all of them. This creates an irregular reachable-bin pattern that can stutter the dB-per-tick response — see the "binary_search on duplicates" lesson below.
- **Anything we want to change about velocity** can be done from the BBB without touching the PIC.

### Velocity resolution is exactly `high − low + 1 + 2` reachable bins (one per integer threshold, plus the two open-ended boundary bins)

(Corrects an earlier-and-now-deleted lesson that claimed sub-tick firmware resolution. That conclusion came from a flawed simulation that fed fractional keys to my binary_search reproduction — but the PIC only emits integer 12-bit ticks, so fractional keys are physically unreachable.)

Empirically validated: with γ_int=1, low=3, high=50, integer keys 0..4095 produce exactly 49 distinct bin outputs from binary_search. Add the two boundary bins (0 for key < low, 127 for key ≥ high) and that's 48 distinct integer thresholds + 1 = 49 reachable. The user observes ~47–48 in practice (depending on whether they ever reach the open-ended bins at both extremes during play).

This means **widening the integer range** is the only way to increase reachable velocity count. Tightening `low/high` to the user's actual press-time range maximises information density (every velocity bin corresponds to an achievable physical press-time), but tightening *below* the range hardware can produce wastes bins and clips the dynamic range.

### Binary_search on duplicate thresholds produces an irregular reachable-bin pattern

When the CMD 0x20 integer threshold range is narrower than 127 entries (e.g. low=3, high=50 spans 48 integers across 127 entries), each integer value occupies a run of 2–3 adjacent table indices. The BBB's `binary_search` returns the index where an exact match is found via bisection — which lands at a specific mid in each run, not the first or last. Result: adjacent integer keys produce bin-index jumps that alternate between Δ=2 and Δ=4 (one extra step every ~3 ticks). After the CMD 0x08 identity LUT, this becomes alternating dB-step sizes (e.g., 0.31 / 0.31 / 0.31 / 0.65 / 0.31 / 0.31 / 0.31 / 0.65 / ... at γ_audio=2.3).

**Fix**: widen `high` so the integer threshold count equals 127 (e.g., for low=3, set high=130 → 128 distinct integers fill the table with no duplicates). Every integer key then exact-matches at a unique index, and the reachable bins become contiguous 1:1 with tick count. Costs nothing on the user's natural play range (they still emit ~48 distinct velocities for 48 distinct press-times), but eliminates the structural step-doubling.

Trade-off: full-range vels compress into the loud half of MIDI velocity space (vel ≈ 80..127 for press-times 3..50, with vel ≈ 1..79 for press-times the user doesn't physically produce). Compensate downstream with a much steeper audio γ (≈14 for full 30 dB range under high=130, vs ≈2.3 for the same range under high=50).

### "Match audio gamma" intuition is wrong for the CMD 0x20 curve

Tempting reasoning: if the audio curve is γ=2, setting CMD 0x20's γ_int=2 should "cancel" and give a uniform perceptual ramp. Empirically wrong — power-law composed with power-law is still a power law, not uniform in dB.

What's actually correct: γ_int = 1 (linear), regardless of γ_audio. With γ_int = 1 the velocity output is a 1:1 monotonic function of press-time tick count, and the audio curve's shape is then the only thing affecting per-tick dB stepping. Any γ_int ≠ 1 just adds confusion about the bin distribution without changing the reachable-velocity count.

For "uniform dB per tick" the press-time → gain composition would need to be exponential. Power laws can't produce that, so accept a residual taper: bigger dB steps at the loud end, smaller at the soft end. This is a property of `gain = floor + (1−floor)·(v/127)^γ`, not a defect.

### Hardware MAX is not a reliable dynamic-range lever for narrow-ADC-swing keyboards

The MAX-raising workflow under "Per-key calibration converges in 3-4 passes" assumes the dead-key rate climbs gracefully as MAX rises. On Max's unit it doesn't — `MAX=70` produces ~3 dead keys, `MAX=80` produces 20+. The casualty distribution is unit-specific; some keyboards have so tight a physical ADC swing distribution that any meaningful MAX bump kills 5–10% of the keyboard. And even on surviving keys, p5 doesn't drop when MAX climbs, because the firmware's press-time → velocity mapping is insensitive to where the measurement window sits within Max's compressed swing range.

Before assuming the iterative `--bulk-change` / rescue loop will work on a given unit, *diagnose first*: bump MAX by ~10 counts once, count dead keys. If the count jumps from a handful to 20+, the hardware lever is exhausted. Pivot to software input-curve shaping (`docs/decisions.md` → "Velocity shaping: software input curve over hardware MAX raising"). The Phase 3 MIN tuning (raising MIN selectively for keys with p95 < 100) still works — it's independent of the hardware envelope and addresses a different failure mode.

### Rest consolidation in voicing fixes the "mirroring" bug

When `voicing.ts` splits a chord across staves via the middle-C threshold, the off-hand staff gets a rest of identical atom structure to the original chord. For a treble passage of 8 eighth notes, the bass would emit 8 eighth-rests mirroring the rhythm — visually wrong (an all-rest bar should be a single whole rest).

Fix: after the voice split, walk each voice's stream; consecutive rests merge into one duration, slice at bar boundaries, re-fed through `splitDuration` (the duration DP). A treble bar of 8 eighth notes against an empty bass voice → bass gets a single `r1` after consolidation. A treble + a single quarter-note pickup in the bass → bass gets `quarter + half-rest` (the user's specific example).

The re-fed DP runs per-bar slice so rests don't tie across bars (rests don't carry ties — `r2 ~ r2` is invalid LilyPond).

### Asymmetric cross-references silently fail on the "rare" direction

`data-tie-partner` had two writers with different conventions: `toggleTieOnCurrent` set it bidirectionally on each pair; `insertWithSplit` (auto-tie-on-overflow) set it backward-only (each `m`/`t` piece pointed at its predecessor; the `i` initiator had no back-reference). The orphan-cleanup code walked `data-tie-partner` from the deleted note to find the partner — which worked for `toggleTieOnCurrent`-created pairs (either side knew the other) but missed cases when the `i` side of an `insertWithSplit`-created chain was deleted. The downstream `m`/`t` survivors were left with `data-tie-partner` pointing at a deleted xml:id, and Verovio emitted "Expected @tie median or terminal in note 'X'".

The asymmetry was latent for months because typical use (toggle on adjacent notes; delete the second) hit the symmetric path; the bug only fired when a chain's initiator was deleted, which the user reached via "tie a note, then backspace into the chain head". When a single attribute has multiple writers with different invariants, expect the rare direction to be wrong. Fix here: split persisted INTENT from derived REALIZATION, and centralize realization in one idempotent pass (`normalizeTies`) — see decisions.md.

### State machines outside the model leak across automated tests

`tools/composer-test/run.mjs`'s first cut reset Composer between fixtures by calling `model.replaceDocument(emptyMei)`. That works for the MEI document but NOT for the input.ts module-private `state` object (entry mode, cursor mode, pending hairpin/tuplet), `main.ts`'s `lastHeldKeys`, the score scroll position, or the renderer's view mode. A prior fixture pressing the `Insert` key left `mode='overwrite'` set for the next; a prior bridge test left A3 "held"; page mode left the viewport scrolled into a corner of empty paper.

The toolbar gave it away the moment the visual baselines were inspected — "OVR" mode and "held: A3" both shown despite a fresh model. Fix: `RESET_SNIPPET` now explicitly clears every ambient state machine that lives outside the model — `getInputState()` returns a runtime-mutable reference (`Readonly<>` is a TS type only), `lastHeldKeys` clears via a `held-keys: []` bridge broadcast, `score.scrollLeft/scrollTop` zero directly, `renderer.setViewMode('scroll')` forces deterministic layout. Whenever new global state is added to Composer, the reset path needs the same treatment.

### ASI bit me in a template-literal-injected IIFE

`runner-core.mjs` initially wrote
```js
const INJECT_LIB = `(() => { window.__cursorTrace = ${CURSOR_TRACE_FN}; return ${ASSERTION_LIB}; })()`;
```
where `ASSERTION_LIB` was itself `(() => { ... })()`. After interpolation the embedded text started with a newline followed by `(...)`, and Automatic Semicolon Insertion parsed `return\n(() => { ... })()` as `return;` followed by an unreachable expression statement. `window.__test` never got defined; every assertion threw `Cannot read properties of undefined`.

The injection LOOKED right and the surrounding eval succeeded — the result just came back `undefined`. Defeat ASI by always parenthesizing interpolated expressions in JS-string templates: `return (${EXPR});`. Same trap applies to any code generator that embeds expression text into a function body.

### Headless Chromium leaks on parent-shell kill

`lib/chromium.mjs` spawns Chromium and exposes a `stop()` callback that the runner's `main()` calls in a `finally`. That works for the normal exit path. It does NOT work when the parent shell of a background bash invocation gets killed mid-task — the `finally` doesn't run, and Chromium plus its `/tmp/hkl-composer-test-*` profile directory leak. Several hours of background-shell test runs left ~30 zombie processes pinning ~3 GB of memory and disk.

Two fixes available, neither yet applied to `chromium.mjs`:
1. Have the spawned Chromium inherit the parent's process group and rely on the kernel's reaper on SIGHUP — works if the launcher uses `setpgid(0)` and the parent dies cleanly.
2. Write the Chromium PID to a known location at launch and clean up stale entries on the next runner start.

Pragmatic interim: run probes in the foreground (don't background with `run_in_background: true` unless the task is genuinely long-lived), and periodically `pkill -f "hkl-composer-test-" ; rm -rf /tmp/hkl-composer-test-*`.

### Visual screenshots in page mode capture mostly empty paper

CDP `Page.captureScreenshot` with `clip` set to the rendered SVG's `getBoundingClientRect()` should give a tight crop of the music. In page mode the rendered SVG IS the paper page — full-toolbar width by ~A4 height — with the music tucked into the top-left corner. The clip rect was correct (matched the SVG bbox); visible content occupied < 5% of the clip area; any visual regression would be lost in the white expanse.

Earlier fix (since superseded): force scroll mode in `RESET_SNIPPET`. That avoided the empty-paper problem but produced screenshots that didn't match live behavior (Max uses page mode), defeating the purpose of pixel tests.

Current fix in `tools/composer-test/lib/visual.mjs`: compute the clip bbox as the union of `<g class="system">` elements + selection overlay rects + any non-zero-opacity cursor overlay child, plus 16 px padding. The tests now render in the same view mode as live use, and the screenshot is still a tight crop of the content.

Generalizable rule: don't force the page into a test-only render mode to make visual tests work — that bakes a "tests don't reflect live behavior" assumption into the suite. Compute a content-based crop instead.

### Test invariants that mutate render state pollute later invariants' pixel reads

The composer-test suite runs invariants in sequence per fixture: model assertions, then cursor-trace, then visualCheck. The cursor-trace helper walks every cursor position and calls `cursor.update(model, { cursorMode: 'voice', … })` to repaint the cursor at each position. It hardcoded `'voice'` because that was the cursor's only mode at the time it was written.

When selection mode was added, this turned into a bug: a fixture that ends in selection mode (cursor hidden) would have its hidden state OVERWRITTEN by the cursor-trace pass's voice-mode repaint right before visualCheck took the screenshot. The DOM at screenshot time correctly showed `opacity="0"`, but the painted pixels were from the cursor-trace's forced voice-mode paint — depending on exactly when Chromium committed each paint to its frame buffer. Visually the cursor appeared in the baseline even though the assertion checking `opacity` passed.

Fix: cursor-trace's `refresh()` now reads `cursorMode` from the live `inputState()` rather than hardcoding voice mode. Generalizable rule: any test invariant that touches render state must read the same state the production code reads — or be made fully read-only (e.g. snapshot bboxes without re-issuing renders). When invariants mutate state, the order in which they run becomes a load-bearing implementation detail, and adding a new state (like selection mode) silently breaks the suite.

### `visualCheck` clip bbox is scoped to `#score` only — overlays don't capture

`tools/composer-test/lib/visual.mjs:visualCheck` computes its screenshot clip rect from `#score`-internal targets: `g.system` elements, selection-overlay rects, and the cursor overlay. The clip fits tight around music content (and is unaffected by Verovio's paper-sized SVG canvas; see §"Visual screenshots in page mode…").

The consequence: fixtures whose primary visual target is a **top-level overlay** — `<dialog>`, popover, toast — won't be captured. The dialog lives outside `#score`, so the bbox routine treats its presence as invisible and the resulting baseline screenshots only the (probably empty) score area beneath. Adding `visualBaseline: '…'` to a help-modal / setup-modal / popover fixture produces a passing but useless baseline: the modal is shown, but the saved PNG doesn't include it.

Two paths if you want overlay-aware visual coverage: (a) extend `visualCheck` with an explicit clip-mode arg (e.g. `bboxFrom: '#helpDialog' | 'viewport' | 'score'`), or (b) write a one-off screenshot via `Page.captureScreenshot` without a clip. The "just add `visualBaseline:`" path will silently produce a wrong baseline; resist it.

### Test/live divergence: diff the flows before hypothesizing

When a test produces output that doesn't match live behavior on the same code: the *first* move should be to enumerate the concrete differences between the test flow and the live flow — every command the test runner issues that the live browser doesn't, in order. Speculation about caching, animations, paint timing, or framework quirks tends to be wrong and burns hours.

Concrete things to compare:
- What JS does the test harness inject into the page that a live browser doesn't? (assertion libs, mock channels, helper functions.)
- What does the test harness call between the user's last input and the screenshot/observation? (cursor traces, model walks, RAF waits.)
- Does the test harness force any mode/setting that production doesn't? (view modes, fixed window sizes, disabled GPU.)

If those four questions don't surface the divergence, the actual cause is rare. Don't reach for rare causes first.

### Verify file writes by checking mtime/size, not exit code

`node run.mjs scenario X --update-baselines` exited cleanly multiple times while doing nothing, because scenario tier silently skipped the visual invariant. The fix was a one-line check (`mode === 'scenario'` doesn't satisfy `mode === 'visual' || mode === 'full'`), but it cost an hour because "the command succeeded" was treated as proof the file was rewritten. Always `stat` or `ls -la` the output file when verifying a write — the runtime didn't lie, it just wasn't asked to do anything.

### Composer cursor convention split: `getTickPositionAt` vs `getTimeAt`

`model.ts` has two functions for "what tstamp does cursor c sit at" that disagree by one element:

- `getTickPositionAt(voice, c)` uses `locateCursor`'s anchor-on-`flat[c]` view: cursor c sits "past flat[c]". This is the convention used by `insertChordAtCursor`, `deleteAtCursor`, `replaceChordAtCursor`, and the rest of the user-facing mutation API.
- `getTimeAt(voice, c)` sums `realTicks` of `flat[0..c-1]`: implicitly "cursor c sits past flat[c−1]" (= one element earlier). Paired with `findCursorAtOrBefore` in `switchVoice` for cursor preservation across voice switches.

The two are internally consistent in `switchVoice`'s round-trip (both sides use `getTimeAt`'s convention so the offset cancels). But mixing them — computing a tstamp via `getTickPositionAt` and then converting back to a cursor via `findCursorAtOrBefore` — yields a cursor that's one element to the right of the locateCursor-convention answer. In a paste path, that meant `insertChordAtCursor` anchored on the wrong element and inserted AFTER the next surviving element instead of into the just-deleted slot.

Fix: `findCursorByTickPosition(voice, t)` uses the locateCursor convention (walks via `getTickPositionAt`). New code that pairs tstamps with `insertChordAtCursor`-style mutations uses it.

Generalizable rule: when a model has two conventions for indexing into the same sequence (here: nav stops), don't paper over it by silent conversion. The off-by-one bug spent time hiding because each side of the pairing was internally consistent and produced plausible values when looked at in isolation. Naming the helpers after the conventions they obey (`findCursorByTickPosition` vs `findCursorAtOrBefore`) makes the call sites self-documenting.

**Follow-up (2026-05): tick-self-consistency was the wrong invariant for `switchVoice`.** The earlier conclusion that `switchVoice` was safe with `getTimeAt` + `findCursorAtOrBefore` ("self-consistent round-trip") held for *absolute tick*, but the user-visible invariant is *visual measure* — switching voices should never change the measure the cursor renders in. These come apart at measure boundaries because wrapper stops (`<measure>` anchors emitted by `shouldEmitWrapper`) have zero `realTicks`, so the same absolute tick maps to cursor stops in different visual measures: "past last content of M_n" and "wrapper of M_{n+1}" alias. `findCursorAtOrBefore` resolves the ambiguity by picking the largest cursor with cumulative ≤ target, which lands in whichever measure happens to come first in the target voice's flat stream — usually the wrong one when the two voices have different content shapes (e.g. V_1 empty M_1 + content M_2, V_2 full M_1 + empty M_2 → switching from V_1 M_2 lands in V_2 M_1).

Fix: `model.setVoicePreservingMeasure(tgtV)` translates by `(visualMeasure, withinMeasureTicks)` — read `cursorMeasureIdx` and the within-measure offset, then `findCursorByTickPosition` on the target voice with a `cursorVisualMeasureAtIndex` guard that falls back to `getFirstVisualCursorInMeasure` if the candidate lands in the wrong measure (the placeholder invariant guarantees this fallback succeeds). Both `switchVoice` and the expr-layer exit path now go through this helper. `getTimeAt` / `findCursorAtOrBefore` are still used by playback and selection — their tick convention is correct *for those callers*; just don't reach for them for voice translation.

Generalizable rule for cursor models with structural anchors (wrappers, sentinels, zero-duration stops): any cross-axis translation needs to preserve the *structural coordinate* the user perceives (here: measure), not the derived scalar (here: tick). "Self-consistent round-trip in scalar X" is not the same as "preserves invariant Y" unless Y is a function of X alone — and at boundary anchors, it usually isn't.

### Verovio measure bbox includes the barLine glyph (= "right edge" is past the visible bar line)

Each Verovio `<g class="measure">` renders its right barLine as a child element, INSIDE the measure group. So `measureGroup.getBoundingClientRect().right` extends past the visible bar line center by half the barLine glyph's width.

For a mid-system bar line (= a bar line that has a next measure on the same system), `M_{k+1}.bbox.left` is a better proxy for the visible bar line position — the next measure's content starts right where the barLine ends. For the last measure on a system (or the last measure of the score), there's no next measure to query and `M_k.bbox.right` IS the visible position (it's the system-ending bar line).

Surfaces specifically as "selection rect ends a few pixels past the bar line when growing TO it (from the left), but looks correct when shrinking back TO it (from the right)" — because the left edge of the selection used `M_{k+1}.left` (correct) while the right used `M_k.right` (past).

Fix lives in `src/composer/selectionOverlay.ts:measureRightEdge`. Generalizable rule: when aligning UI to musical-glyph boundaries, the glyph's own bbox isn't the visual edge — the adjacent glyph's start is more reliable.

### SMuFL HEJI syntonic-comma arrows are combined glyphs, not standalone arrows

The SMuFL "Extended Helmholtz-Ellis accidentals (just intonation)" range
(U+E2C0–E2FF) provides ONLY combined "accidental + N arrows" glyphs —
e.g. U+E2C2 is a *natural sign with one down-arrow* as a single composite
glyph, not a standalone arrow. There is no SMuFL codepoint for a bare
syntonic-comma arrow; HEJI treats the arrows as inseparable from a
Pythagorean carrier. (Standalone septimal hooks DO exist —
`accidentalLowerOneSeptimalComma` U+E2DE and Raise U+E2DF — because those
aren't conventionally combined with Pythagorean accidentals.)

Practical consequence: you can't render "C#" in sans-serif followed by a
Bravura arrow next to it. The whole accidental glyph must be replaced by
the combined Bravura glyph. HKL's HEJI label-builder (`src/tuning/heji.ts`)
distributes syntonic commas across the Pythagorean accidental chain (up to
2 per glyph), then spills extras onto appended natural-sign carriers — so
the only situation where a label has no full accidental glyph is the
bare-letter Pythagorean-spine case (no accidentals, no commas, no hooks).

Verify codepoints against `w3c/smufl/gh-pages/metadata/glyphnames.json`,
NOT against ChatGPT-style summaries — both my first two guesses (0xE2C2 as
a "standalone up arrow" and 0xE2D8–E2DB as septimal hooks) were wrong;
0xE2D8 is "DoubleSharpThreeArrowsDown" and 0xE2C2 is the natural+1-down
combined glyph. The canonical table is the spec JSON.

### Bravura WOFF2 lives in `redist/woff/`, not `redist/woff2/`

The steinbergmedia/bravura repo's `redist/` directory has `otf/`, `svg/`,
and `woff/` subdirectories. The WOFF2 files (`Bravura.woff2`,
`BravuraText.woff2`) live INSIDE `woff/` alongside the WOFF1 versions.
There's no `redist/woff2/` directory. Don't guess the path. Also: the
default branch is `master`, not `main`, so jsdelivr URLs need `@master`
or an unversioned form.

Working: `https://cdn.jsdelivr.net/gh/steinbergmedia/bravura@master/redist/woff/BravuraText.woff2`

For HKL we host a local copy in `public/BravuraText.woff2` (Vite copies to
`dist/` at build time) and keep the jsdelivr URL as a `src:` fallback.

### Bravura SMuFL glyphs render much smaller than Unicode equivalents at the same px size

Bravura's accidental glyphs are engraved to fit a 5-line music staff —
roughly 1 staff-space tall (= 1/4 em). At the same font-size, a Bravura ♯
appears noticeably smaller than the Unicode ♯ rendered in a sans-serif
font. BravuraText (compiled with text-style metrics) helps but doesn't
fully close the gap.

In HKL's `drawHejiLabel`, the Bravura glyph font size is set to 1.8× the
letter font size to match the visual weight of the conventional path
(sans-serif Unicode ♯/♭). Without that scale-up, HEJI labels look tiny
next to the conventional ones. Tune for legibility, not formal metric
correctness — these are lattice cell labels, not staff notation.

### `actualBoundingBoxAscent` is relative to the current textBaseline, not the alphabetic baseline

`TextMetrics.actualBoundingBoxAscent` reports the distance from the **current** `ctx.textBaseline` to the top of the rendered bbox — not from the alphabetic baseline as the MDN doc skim might suggest. With `textBaseline='middle'` (used in `drawNoteName` so the y coordinate refers to the glyph's visual center), the same accidental's reported ascent is roughly half what it would be with `textBaseline='alphabetic'`.

This matters when computing superscript positions for the exponent-collapse renderer (`drawHejiLabel` in `src/render/draw.ts`): the digit is positioned via `cy + yOff - collapseAscent + collapseAscent × EXP_ASCENT_FRAC`. Switch textBaseline mid-routine without remembering this and the superscript floats wildly off the glyph.

If you need a baseline-stable measurement, set textBaseline='alphabetic' for the measurement, then restore. But for the common HKL pattern of "measure-and-draw at the same textBaseline", the value is internally consistent — just don't import it as a normalized ascent.

### Headless CDP doesn't synthesize clipboard events from keystroke dispatch

`Input.dispatchKeyEvent` fires keyboard events at the renderer-input level but does NOT synthesize the `copy` / `cut` / `paste` DOM events that real browsers fire on Ctrl+C / X / V. So when copy/cut/paste behavior is split across keydown (model side-effects) and DOM events (OS clipboard I/O), only the keydown half is exercised by CDP tests.

Workaround in HKL: the keydown handler keeps doing the model side-effects (selection serialize, deletion, etc.) AND stashes the serialized clipboard text in a module-level variable. The DOM event handler (real-browser-only) picks it up to write the OS clipboard. CDP tests observe model state via the keydown path; OS-clipboard round-trip is verified manually in real browsers.

Generalizable rule: when splitting a user gesture's effects across multiple event types, ensure each individually testable path is observable. A test that drives Ctrl+C and asserts model state should pass even if the OS clipboard write requires a DOM event that the test harness doesn't synthesize.

### Handshake feedback loop: symmetric hello-echo + reply-on-hello = infinite ping-pong

The Composer ↔ HKL bridge has two `hello` lifecycle messages (`composer-hello`, `hkl-hello`) and HKL's `composer-hello` handler calls `announce()`, which broadcasts `hkl-hello`. That's fine as long as Composer's `hkl-hello` handler doesn't broadcast `composer-hello` in reply — but it's natural to want exactly that, so HKL can learn Composer is alive when HKL boots second (Composer's load-time `composer-hello` was lost to a then-absent listener).

Wire that naively and you get: `hkl-hello` → `composer-hello` → `announce()` → `hkl-hello` → `composer-hello` → … forever. Each iteration also re-invalidates Composer's broadcast caches and re-fires `maybeBroadcastSongKey` etc., so the storm includes payload messages — `set-song-key` and friends get sent every cycle. Symptom: ref-tier updates appear to "stop working" because the channel is saturated.

The cure isn't to drop the reply (you still need it for late-HKL-boot), it's to gate it on a *state change*: only echo `composer-hello` when Composer transitions from "no HKL" to "connected". A `wasConnected` snapshot taken before flipping `hklConnected = true` is enough:

```ts
const wasConnected = hklConnected;
hklConnected = true;
if (!wasConnected) {
  bridge.send({ type: 'composer-hello', version: PROTOCOL_VERSION });
}
```

`composer/main.ts:hkl-hello`. Generalizable rule: in any pub/sub handshake where receipt triggers a reply AND the reply triggers a re-receipt, gate the reply on a state transition — never on the event itself.
