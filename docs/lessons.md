# HexKeyLab Lessons Learned

Hard-won truths that aren't obvious from reading the code. Anti-patterns that burned us. Subtle behaviors that look like bugs but aren't. Read this before debugging anything that smells familiar, and add to it whenever something costs more than 30 minutes to figure out.

---

## Hardware

### The Lumatone expression jack is wired Roland-style

The expression jack expects the wiper signal on the **ring** of a TRS plug. Korg-style pedals (DS-1H, DS-2H, switch sustain pedals) put the pot between tip and sleeve and leave the ring unconnected. Plugged into the Lumatone, those pedals look like a floating ADC pin — slow capacitive drift downward, mechanical perturbations spiking to rail, no actual position information.

Two pedals with completely different electrical signatures producing identical behavior is the diagnostic tell. Calibration and sensitivity adjustments cannot rescue this — there is no signal on the read pin.

**Working pedals**: Roland DP-10 (with body switch in "Continuous" mode), Roland EV-5, Yamaha FC7 (with Invert Pedal toggle).

### Boards 3 and 4 are physically swapped on Max's unit

This is a per-unit hardware quirk, not a firmware feature, so it's a **persisted toggle** (*Calibrate Keys → "Swap boards 3 ↔ 4"*, pref `swapBoards34`, **off by default**). The HKL SysEx path routes through `sysexBoardFor(group)` (`lumatone/protocol.ts`): identity `[1,2,3,4,5]` when off, `[1,2,3,5,4]` when on — never hardcode either at a call site. With the swap off on a transposed unit (or on with a standard one), key colors and remappings land on the wrong physical boards. (The `tools/lumatone-cal/` Python scripts, which poke device memory directly, encode the swap separately — see lumatone-calibration.md.)

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
1. Boards 3 and 4 are physically swapped on Max's unit, so spatial position ≠ PIC number. The swapped mapping `[1, 2, 3, 5, 4]` translates spatial→PIC (in HKL, gated by the `swapBoards34` toggle; these Python scripts assume it for Max's unit).
2. TC's in-memory per-board state and on-disk `KeyData_N` files are indexed by **PIC number** (the BBB doesn't know about the physical swap; it only sees electrical wiring). Memory slot `i` (0..4) corresponds to `KeyData_(i+1)` and to PIC `i+1`.

When poking memory for a key at HKL coords (q, r): compute `sysex_board = [1,2,3,5,4][board_group]`, then memory slot = `sysex_board - 1`. Using `board_group` as the slot index reads the WRONG board (the one physically swapped with the intended one).

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

### `DEFAULT_PREFS.waveform` must be a real `#waveform` `<option>` value

`applyPrefsToDom` (`ui/init.ts`) does `$<HTMLSelectElement>('waveform').value = p.waveform`. If that value isn't one of the select's `<option>`s, the assignment **silently fails** — the select's `.value` becomes `''` — and the bootstrap `changeWaveform()` then reads `''`, sets `audio.activeWaveform = ''`, and persists it. The first note plays through the oscillator branch with `osc.type = ''`, which Web Audio rejects with a console warning ("`''` is not a valid enum value of type OscillatorType") and produces no sound. This bit us: the default was `"splendid_piano"` (a valid `INSTRUMENTS` key, but **not** a menu option — the menu's "Piano" is `maestro_piano`), so every fresh profile booted with an empty waveform until the user manually picked an instrument.

Two guards now exist: (1) the default is a real option (`maestro_piano`); (2) the osc note path is gated by `isOscType(wf)` (`audio/engine.ts`) so a stale/invalid waveform never reaches `osc.type` — it just produces silence until a real instrument resolves. Rule: any pref mirrored into a `<select>` via `applyPrefsToDom` must be a value the select can actually hold, or it falls back to `''` silently. (Same class of bug the imported-`.hki` optgroup comment at `ui/init.ts:112` already warns about.)

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

### Fixing a malformed font cmap = round-trip through fontTools (don't hand-edit, don't re-fetch blindly)

`public/BravuraText.woff2` (loaded via the `@font-face` in `apps/hkl/index.html`) shipped with **two `0xFFFF` terminators** in each of its two format-4 `cmap` subtables, which Firefox's OTS sanitizer flags ("`downloadable font: cmap: multiple 0xffff terminators found`"). The font still loads — it's a warning, not a rejection — but the fix is to ship a clean binary. fontTools normalizes the cmap on *read*, so a decompile-then-save round-trip recompiles a canonical single-terminator cmap while leaving every other table byte-identical:

```
woff2_decompress BravuraText.woff2        # -> .ttf (brotli not needed for this CLI)
# /usr/bin/python + fontTools: TTFont(ttf); touch f['cmap'].tables; f.save(out.ttf)
woff2_compress out.ttf                     # -> clean .woff2
```

Verify by parsing the raw cmap (endCode arrays) for the `0xFFFF` count before/after, and assert the unicode coverage set is identical (19,179 codepoints here) so no glyphs were dropped. **You cannot verify this via the HKL console scanners** — OTS font warnings are DevTools-console-internal (see Process/workflow), so confirmation requires a human reload in Firefox. Only `public/BravuraText.woff2` is tracked; the `overlay-host/embedded` + `dist-overlay` copies are gitignored artifacts that regenerate from it.

---

## CSS / DOM

### Class sharing across handler types is a footgun

`querySelectorAll('.tpab')` matched both transpose AND seam-shift buttons because both used `.tpab` for styling. Seam-shift buttons lacked `data-dq/data-dr`, so the transpose handler hit `+undefined = NaN`, then `keyFreq(NaN) = NaN`, then `setValueAtTime(NaN, …)` threw. Symptom was a vague audio breakage on seam shift.

**Rule**: when a handler depends on specific attributes, qualify selectors with attribute filters: `.tpab[data-dq]`. Don't rely on the class alone if other elements share it for styling.

### `:has()` is fine to use; we already do

`.ctrls label:has(input){cursor:pointer}` is in the existing CSS. Browser support is universal as of 2024. Don't waste time avoiding it.

### Offscreen-measured DOM does NOT inherit container-scoped CSS — mounting can shift geometry

The virtualized scroll renderer measures each chunk's `<svg>` in an offscreen `host` div appended to `document.body` (`chunk-render.ts`), then moves the live svg into a clip wrapper inside `#score`. Geometry read offscreen (`getBoundingClientRect`, wrapper width, the index's per-measure x) is taken in a context where **`#score`-scoped CSS does not apply** — so any rule like `#score.view-scroll svg { margin-left: 24px }` silently shifts the content the moment it's mounted, *after* the measurements that positioned the clip and the index were taken.

This caused the whole "piece-end barline clipped + past-end cursor unreachable" class of bug (issues 1–3 of the virtualization handoff): a stray legacy margin shifted every chunk +24px past its `overflow:hidden` clip and past the canvas/scroll extent. Symptom was maddening because the barline element *was* present in the DOM at the "right" coordinates — the coordinates just didn't match where CSS finally painted it.

**Rules**: (1) Anything measured offscreen and then mounted into a scoped container must not be subject to layout-affecting container CSS (margins/padding/transform on the measured element). Keep such offsets on a *wrapper the renderer owns and accounts for*, not on the measured element. (2) When DOM coordinates "look right" but the visual is wrong, suspect a CSS offset applied at mount that the measurement frame didn't see — compare a render-time `getBoundingClientRect` against the same element's live rect (they should be identical; a constant delta is the smoking gun). (3) `#score.view-scroll` breathing room now lives on the ribbon canvas via JS (`VirtualRibbon.leftMargin`), and the cursor overlay is sized to match (`render.ts scrollOverlayWidth`) — keep those two in lockstep.

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

### Headless console capture (CDP or BiDi) can't see DevTools-console-internal warnings

The HKL console scanners (`test/hkl-inspect/`) drive headless **Chromium via CDP** and headless **Firefox via WebDriver BiDi**. Both protocols surface only **console-API calls** (`console.warn/error/...`) **and JS exceptions** (CDP additionally surfaces browser-level `Log.entryAdded` entries — e.g. Verovio's own logging; BiDi does not even do that). Neither exposes warnings emitted by the browser's *internal subsystems* straight to the DevTools console UI:

- **source-map errors** — the source map is only fetched when DevTools is open, so headless (no DevTools) never triggers the warning at all. Verified: a `source-map-loader` worker error like "URL constructor: is not a valid URL" for `wasm:…verovio-toolkit-wasm.js` only appears with the console open.
- **downloadable-font (OTS) warnings** and the **WASM `'try'` deprecation note** — emitted by Firefox's font / JS-engine subsystems via the internal console service, bypassing the console API.

Empirically, those three categories produce **nothing** in either scanner even after a full Verovio render — while the scanners *did* catch the MEI "No header" warning and the empty-`OscillatorType` error (both real console-API output). Practical consequence: a console-clean scanner run does **not** mean a clean Firefox DevTools console. To debug an internal-subsystem warning, get the exact text pasted from a human's interactive Firefox session; you can't capture it programmatically. (And note: warnings baked into **Verovio's CDN WASM** — the `try` deprecation, the empty `sourceMappingURL` — aren't fixable from HKL source anyway without self-hosting + patching the binary, which the CDN-load architecture deliberately avoids.)

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

Net: Frescobaldi is a great editor for hand-tweaking `.ly` source, but cannot serve as a live preview surface for a streamed-write workflow. HKL Composer uses Verovio in-app for live. (Historical: this informed dropping LilyPond entirely — the `.hkr` → sheet-music path now emits a Composer-native `.hkc` and opens directly in Composer for editing, rather than writing `.ly` for an external tool. See decisions.md "Transcription emits `.hkc` … not `.ly`".)

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

## Transcription quantization

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

The re-fed DP runs per-bar slice so rests don't tie across bars (rests don't carry ties — a tie between rests is meaningless in any notation, and `meiEmit` only assigns `@tie` to note/chord atoms, never rests).

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

### Rendering HEJI / >±3 accidentals in Verovio: the four hard facts

Spiked against Verovio 6.2.0 (the Composer's CDN build) while adding HEJI
accidentals to the score editor. These cost a full investigation phase to
discover; check them before re-deriving:

1. **`@glyph.num` / `@glyph.name` on `<accid>` are silently ignored.** The
   `book.verovio.org` SMuFL-codepoint path (`<accid glyph.auth="smufl"
   glyph.num="U+E2D0"/>`) parses but emits an empty `<g class="accid">` with
   zero reserved width — every format (`U+E2D0`, `0xE2D0`, `E2D0`, with/without
   `glyph.auth`, and `<symbol>`) is a no-op in the WASM build. Dead path.
2. **Verovio's native MEI accidental vocabulary is rich and correctly spaced.**
   `s/f/n/x/ff/ts/tf` plus Gould quarter-tone arrows `su/sd/fu/fd/nu/nd`
   (U+E270 block) and `1qs/1qf/3qs/3qf` all render with correct horizontal
   space. We use these only as **width-reservation placeholders** and then swap
   the rendered glyph in post-processing.
3. **Multiple `<accid>` children: same token collapses, distinct tokens space.**
   Two `<accid accid="x"/>` siblings render at the SAME x (overlap) — distinct
   `xml:id`/`type` does NOT break the dedup; Verovio keys on the `accid` VALUE.
   But `<accid accid="x"/>` + `<accid accid="su"/>` (different tokens) get
   separate reserved slots, side by side. **MEI order is reversed from visual
   order**: the MEI-first sibling renders rightmost (nearest the notehead).
   This is the mechanism behind both the septimal hook (a 2nd distinct
   placeholder) and arbitrary >±3 stacks (N distinct placeholders, glyph-swapped
   to the real codepoint). `@ho` nudges a glyph but reserves no layout space.
4. **`font: 'Bravura'` restyles EVERYTHING, not just accidentals.** Verovio's
   default font is Leipzig. Setting the global `font` option to Bravura changes
   rests, clefs, noteheads — the Bravura rests in particular look worse and it
   re-baselines every visual fixture. Do NOT set the global font merely to make
   native accidentals match injected BravuraText glyphs. Instead the injector
   re-draws *every* accidental as BravuraText `<text>` (plain ones at their own
   SMuFL codepoint parsed from the `<use>` href; HEJI ones at the U+E2C0+
   combined codepoint) — so accidentals are uniformly Bravura while rests,
   clefs, and noteheads stay on Leipzig. "Bravura accidentals only."

Tagging for the post-process swap: put the target in `@type` — Verovio emits it
both as `data-type` AND as a CSS class on the rendered `<g class="accid …">`,
and `xml:id` survives as `id`. (See also §"`svgAdditionalAttribute` always
prepends `data-`".) Injected `<text font-family="BravuraText">` needs the font
loaded first or it renders tofu — gate injection on `document.fonts.load`.
Glyph size: Verovio renders accidentals at `scale(0.72)` on 1000-unit symbols =
em 720 user units = 4 staff spaces (the SMuFL standard); read the placeholder
`<use>`'s transform for the per-note scale + staff-Y baseline.

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

### Vite's default build target is es2020 — top-level `await` needs `target: 'es2022'`

The Vite default `build.target` rolls up to roughly `chrome87 / firefox78 / safari14 / es2020`. ES2020 doesn't have top-level await; trying to ship a module-level `await foo()` from src/ produces a cryptic build error:

```
[vite:esbuild-transpile] Transform failed with 1 error:
ERROR: Top-level await is not available in the configured target environment
```

Fix is one line in `vite.config.ts`:
```ts
build: { target: 'es2022', /* ... */ }
```

That moves the floor to Firefox 89 / Chrome 89 / Safari 15 — all ≥4 years old at time of writing, so probably fine for any HKL feature. If a future feature has stricter compat requirements, the alternative is to wrap the async init in a Promise chain instead of top-level await (see `src/ui/init.ts` before 2026-05-25 for the synchronous-bootstrap pattern). Both work; top-level await reads cleaner when the rest of the file is sequential.

`vite.config.ts:build.target` (set to `'es2022'` 2026-05-25 for the `InstrumentRegistry.init()` await in `src/ui/init.ts`).

### Don't re-encode lossy audio

When bundling audio files into any container, dispatch on source format: keep already-lossy sources verbatim (MP3, OGG, Opus, AAC, M4A), only encode lossless sources (WAV, AIFF, FLAC) to a lossy target codec. Transcoding e.g. MP3→Opus compounds quantization noise; the result sounds worse than either the original MP3 or a fresh Opus encode from the lossless original.

This applies to the `.hki` bundler (`analyzer/bundle.js`), to any future preview-encoding pass, and to the eventual orchestrator (HKLO) which will capture audio output from MIDI keyboards — the orchestrator records to a lossless intermediate format BEFORE handing samples to the analyzer for `.hki` packaging, specifically so the encoder downstream has a clean source to work from.

The pragmatic exception: when the user explicitly opts into a "re-encode everything to opus" mode (smaller bundle for distribution), document the audible cost. Default is preservation.

`analyzer/bundle.js:LOSSY_EXTS` / `LOSSLESS_EXTS` / `targetExt()`.

### `Proxy` over a typed Record is read-transparent but not iterable by default

`INSTRUMENTS` in `src/audio/samples-data.ts` is a `Proxy` over the static map that falls through to the imported-bundle registry on miss. Consumers using `obj[key]` and `key in obj` work transparently because both go through the `get` / `has` traps. But `for..in`, `Object.keys`, `Object.entries`, `JSON.stringify` only enumerate keys reported by the `ownKeys` trap — which defaults to the target's own keys, not the Proxy's virtual ones.

So adding a Proxy-backed virtual-key namespace to an existing typed `Record<string, T>` is safe for accessors but silently changes the iteration semantics: virtual keys vanish from any `for..in` loop. If iteration matters for the consumer, either (a) add an `ownKeys` trap (and a matching `getOwnPropertyDescriptor` — `ownKeys` alone won't enumerate properly), or (b) expose a separate enumeration function that hits the underlying source directly.

HKL chose (b) — `InstrumentRegistry.listImported()` for the dropdown's `<optgroup>` populator, no `ownKeys` trap on `INSTRUMENTS`. There's currently no other consumer that iterates instruments. Adding one in the future would need to opt into the registry list explicitly.

`src/audio/samples-data.ts` (Proxy definition), `src/ui/instrumentBundles.ts:refreshDropdown` (enumeration via `listImported`).

### Firefox `decodeAudioData` refuses some File-derived ArrayBuffers as "unknown content type"

When the Analyzer reads a dropped local audio file via `file.arrayBuffer()` and passes the result straight to `AudioContext.decodeAudioData()`, Firefox **sometimes** throws `EncodingError: The buffer passed to decodeAudioData contains an unknown content type` — for byte-identical content that decodes fine when fetched from a URL. Chromium decodes either path silently, which masks the issue during headless testing.

The root cause is empirical: certain `ArrayBuffer`s produced by the File API don't carry the format metadata Firefox's decoder dispatcher reads, even when the bytes themselves are valid MP3. The workaround is to route the bytes through a Blob URL + `fetch()` instead — `fetch` populates the response with a Content-Type derived from the Blob's `type` field, which the decoder accepts:

```ts
const url = URL.createObjectURL(file);
try {
  const r = await fetch(url);
  return await r.arrayBuffer();
} finally {
  URL.revokeObjectURL(url);
}
```

The Analyzer's `src/analyzer/pipeline.ts` uses a fast-path (`file.arrayBuffer()` + structured copy into a fresh `Uint8Array`, mirroring `samples-engine.ts:213-215`) and falls back to the Blob URL route only when the first `decodeAudioData` call throws. CDN paths don't hit this — `fetch(url).arrayBuffer()` already produces a "good" ArrayBuffer.

`src/analyzer/pipeline.ts:readLocalBytesFast` + `readLocalBytesViaBlobUrl` + `ensureAudioBuffer` (Phase 1 fallback wiring).

### Stacked-canvas overlay: dialog/section CSS background applies to ALL inner canvases

The analyzer's per-sample diagnostic view stacks two canvases: a diag canvas (HKLViz plot) on the bottom, a playhead canvas (transparent, position:absolute overlay) on top. A naive CSS rule like `#sampleTable .inspect-pane canvas { background: #0a0a0a }` paints BOTH canvases with the dark background, making the playhead canvas opaque and OCCLUDING the diag content underneath — even though the diag bytes are correctly drawn (pixel-count probes confirm).

The fix: scope the background by class. Diag canvas gets `.diag-canvas`, playhead canvas gets `.playhead-canvas`. CSS targets `.diag-canvas` only. The overlay stays transparent and the chart shows through.

Same principle applies anywhere a section-level CSS rule targets a generic element type (canvas, div, etc.): if you later add a second element of the same type with different layering intent, the rule will silently break the new element. Default to class-scoped selectors for layered UI.

`src/analyzer/sampleTable.ts` (canvas class assignment), `analyzer.html` (CSS rule for `.diag-canvas`).

### Firefox Web MIDI: outputs need an explicit `open()`; inputs don't (Linux/ALSA)

Symptom: Piano output produced no sound while Piano *input* worked fine, and `amidi -p hw:X,Y -S '90 3C 7F'` from the shell played the synth — so the hardware and cable OUT path were fine, but the browser's sends went nowhere. `aconnect -l` showed the `WebMIDI output` seq client present but with **no `Connecting To:`** line — connected to nothing — while `WebMIDI input` was correctly `Connected From` the device.

Cause: on Linux/ALSA, an input port wires its sequencer subscription the instant you assign `onmidimessage`; an **output** port is not routed to hardware until `MIDIOutput.open()`. **Chrome opens eagerly** (it subscribes every output to every hardware dest at `requestMIDIAccess`), so implicit-open via `send()` works there. **Firefox does not** — without an explicit `open()`, every `send()` is silently dropped. A second trap: orphaned `WebMIDI output` seq clients from prior tabs/processes linger in `aconnect -l` (owned by dead PIDs) and add confusion; restarting the browser clears them, but the real fix is `open()`.

Fix: call `port.open()` when binding an output (`rebindPianoOut` in `src/midi/piano-out.ts`). Don't rely on implicit-open. Diagnose MIDI-routing issues with `amidi -l` / `aconnect -l` / `aseqdump -p '<name>'` to split browser-side from hardware before hypothesizing.

Bonus (same session): the cheap **CH345** USB-MIDI cable (QinHeng) has a flaky MIDI OUT — drops bytes under burst load and can't send SysEx — though simple sparse sends get through. Keep per-note message bursts minimal (we mirror Program Change to all 16 channels *outside* note bursts, never per-note) and don't send SysEx through it.

### Orchestrator (HKLO) capture/discovery gotchas (2026-05-30)

These bit during the orchestrator build; all are about verifying audio-capture code.

**Headless realtime audio is fine for plumbing, too noisy for outcomes.** A realtime
`AudioContext` in headless Chromium delivers worklet quanta *unevenly* across rapid sequential
captures (a velocity sweep), so identical inputs can yield fingerprints that differ enough to
flip a boundary-detection result run-to-run. Don't assert detection OUTCOMES on a
loopback-through-headless harness. Decompose: unit-test the pure logic deterministically
(`detectBins`, `runGates` on synthesized PCM) and let the loopback smoke assert only that the
PLUMBING runs (a sweep returns N fingerprints, a capture returns audio). `test/orchestrator-smoke/`
is split exactly this way.

**Node's native TS runner does NOT rewrite relative `.js`→`.ts` imports.** Node v22+ strips TS
types on import, but only the package-`exports` map (for bare `@hkl/*` specifiers) and Vite
rewrite a `.js` specifier to a `.ts` file. A relative `import './foo.js'` that points at `foo.ts`
(the repo's bundler-mode convention) throws `ERR_MODULE_NOT_FOUND` under `node file.mjs`. So an
app-module node unit test works ONLY if that module's imports are all type-only (erased at
runtime) — `bins.ts` is node-testable, `gates.ts` (real runtime `../analysis/shim.js` import) is
not, and must be exercised in-browser (via a `window.__hklo.*` hook through the CDP smoke).

**Don't pitch-detect to set a sample's frequency when you already know it — trust the claimed
pitch.** When the source plays a commanded MIDI note, the target frequency is *given* (MIDI→12-TET).
Period-detection then only *adds* error: on piano it reads systematically **sharp** (string
inharmonicity pulls the autocorrelation toward the stretched upper partials — a real, register-
dependent bias, ~16 ¢ in practice) and scatters at low SNR (±30 ¢), both worse than a digital
instrument's own equal-temperament accuracy. So `buildHki` stores the claimed freq, not the detected
one (mirrors the analyzer's `trustLabeledPitch`, default-on for local sources). Corollary: an octave
guard is a dead end — autocorrelation can't tell a weak-fundamental high note from a real octave-up
(both have energy at 2F, little at F), so any guard (absolute or `rHalf` vs `rFull` ratio) false-
fails real high notes. Two attempts proved it; we removed octave detection entirely (the device plays
the note we send, so the octave is given). The cents reading is kept as a display-only sanity number.

**Capture/level gates must be SNR / noise-floor relative, not absolute dBFS.** A real input chain is
padded (e.g. a cable's lo switch keeps loud notes from clipping the ADC, parking everything ~15–20 dB
low) and every sample is later normalized — so absolute thresholds (peak < −24 dBFS = "quiet",
< −60 dBFS = "stop") mis-fire: good padded samples read as silent/quiet, and tails never reach a
fixed floor. Measure the noise floor from each capture's pre-attack pre-roll and judge in SNR (which
survives normalization): quiet = SNR < 12 dB, stop = within ~1 dB of the floor, audible length =
time above floor+margin. The scaffold's absolute thresholds (tuned against a clean full-level
loopback) all had to be reworked the first time real padded audio hit them.

**Sparse pure-sine spectra make normalized band fingerprints jitter.** A few-harmonic synth tone
puts almost all energy in a handful of FFT bins; tiny capture/onset differences migrate a partial
between adjacent log-bands and swing the *normalized* band vector wildly (distances near 1.0 for
identical inputs). Fix that hardened the real detector: a **triangular (mel-style) overlapping
filterbank + log compression** (a partial near a band edge splits smoothly across neighbors).
Test fixtures (the loopback) should also use a dense `1/nᵏ` harmonic series, not a few sines.

**A velocity sweep's first probe is a systematic outlier** unless you (a) warm up with a discarded
capture (the first capture of a cold `AudioContext` can be near-silent) and (b) gap longer than the
instrument's ring-out (every probe but the first otherwise captures its predecessor's decay tail;
the unpolluted first probe then reads as a false low-end boundary). `runSweep` does both.

### Capturing a hardware instrument's audio — the input chain is the fragile part (2026-05-31)

When HKLO "won't see the input," the bug is almost always the analog/USB input device, not the code.
Hard-won facts from sampling a Korg into a Framework laptop:

**A combo headset jack is not a line input, and its capture is conditional + fragile.** Max's
Framework **Audio Expansion Card** exposes its (mono, mic-level) capture endpoint *only* when its
jack-detect senses a mic/headset plug; it failed three distinct ways across one project: (1) the input
never enumerated with the wrong cable; (2) after a USB event it silently flipped to an *output-only*
profile (`pactl` Active Profile `output:analog-stereo`, all profiles `sources: 0`); (3) after a
suspend/resume it dropped the capture **USB interface entirely** (`/proc/asound/cardN/stream0` showed
`Playback:` only, no `Capture:`; the USB descriptor had a Headphones output terminal and no input
terminal). No PipeWire/profile/`pactl set-card-profile` action can route a capture endpoint the device
isn't presenting.

**Diagnose top-down to localize OS-vs-firmware:** `arecord -l` (is there a capture device at all?) →
`pactl list cards` (active profile + `sources:` count + port availability) → USB descriptor
(`lsusb -v`) / `/proc/asound/cardN/stream*` (Playback vs Capture endpoints). If the capture endpoint is
absent at the `/proc/asound` / descriptor level, it's a device/firmware decision — stop poking PipeWire.

**Recovery that actually worked:** a full **reboot + reseat the cable into the jack while the source is
sounding**. Software re-enumeration (`echo 0/1 > .../authorized`, `usbreset`, driver unbind/rebind) and
even a physical *card* reinsert were NOT enough on their own — the jack-detect needs to fire at
enumeration with a signal present on the mic contact. (A cold reinsert that *fails* tells you it's the
detection conditions/contact, not a stuck state a reset clears.)

**Gain staging:** the source's hot output overloads a mic-style ADC; pad it (the cable's lo switch) so
the loudest layer peaks near −3 dBFS without clipping — that's also the best SNR point since the noise
floor is fixed. `tools/audio-noise-scan.mjs <wav>` reports RMS/peak/clipping + tonal-vs-broadband noise
(uses the discovery FFT) for dialing this and identifying hum/whine.

**The durable fix:** a dedicated class-compliant **USB line-in interface** presents a fixed stereo
capture endpoint that survives suspend/resume and doesn't depend on jack-detect. The combo-jack path
*can* work (Max shipped a Korg `.hki` from it) but is high-maintenance; everything downstream of a
stable capture device "just works."

### Diagnosing a sampled instrument's whine — post-gain noise, not gain; notch, not subtract (2026-07-12)

Hard-won from cleaning up the SP-250's high register:

**A device's own tonal whine (DAC/switching-clock artifact) scales with its master volume and is
identical in every note.** So you can't out-record it (louder = proportionally louder whine, no SNR
gain — and it costs inter-layer data), and coherent copies **stack** across a chord (+6 dB per
doubling of notes). Because it's a *pure fixed tone*, spectral subtraction can't touch it cleanly;
**notch** it, calibrated from an idle recording (it's absent from a silence-only NR profile only if
you never recorded idle — record idle and it's right there). See `analysis/dewhine.ts`.

**The predictor of an audible whine on a boosted layer is the POST-GAIN noise floor
(`gain × cleaned pre-roll floor`), NOT the gain.** A clean high note that needs 167× is fine
(−100 dBFS floor → −56 dBFS boosted); a noisy one at 224× is not (−77 → −30). Ranking by gain alone
mis-orders them. The reliable skip metric is post-gain noise > −45 dBFS.

**When a note "whines," localize it before assuming broadband noise.** Measure the *pre-roll* floor
AND the *tail* separately, boosted by the gain. Broadband-floor whine (elevated pre-roll → boosted
hiss, e.g. A6) is a skip candidate; a tail full of the note's own closely-spaced partials beating
(e.g. A4's 439/445/434 Hz at 105× — piano multi-string detuning) is a *natural artifact of the boost*,
not a bad capture — retry it (it's a local gain outlier), don't skip it.

**A quiet note going silent is often `computeGain` returning null**, not a capture miss: a fast decay
has too few momentary windows above the K-weighting −70 LUFS gate → null → caller defaults gain to
1.0 → inaudible. The fix is a loudest-window RMS fallback in `measureDecay`, not touching the capture.

## Composer: mid-measure clef vs the leading-signature region (cursor anchor)

`renderer.findSigEndXForStaff` (render/render.ts) finds the right edge of a measure's **leading**
clef/key/meter signatures so the start-of-measure cursor (`anchorAtMeasureLeft` in cursor/cursor.ts)
sits just past them. It collected ALL `g.clef`/`g.keySig`/`g.meterSig` within the staff's bbox and
took the rightmost — which, once mid-measure clef changes (Phase 4.3 inline `<clef>`) exist, wrongly
included a clef change and dragged the cursor-0 anchor rightward past it. **Fix:** only count sig
groups left of the staff's first notehead (`g.note`/`g.chord`/`g.rest`) — the leading region is, by
definition, everything before the first note. A clef change sits after notes, so it's excluded; a
measure that legitimately *starts* with a sig change (mid-score key/meter, or a start-of-measure
clef) is still left of the first note, so it's kept. Fixture: `phase4_clef_cursor_start`.

## Widening `Voice` to a `number`: the `1..4` all-voices loops are silent caps

Phase 5 changed `Voice` from `1|2|3|4` to `number` and added the instrument table, but the many
**"iterate all voices" loops** scattered across the model (`findElement`, `fillIncompleteMeasures`,
`normalizeTies`, `measure-ops`, deletion-ripple, `scTranspose.gatherSoundingAt`, `history.snapshotCursors`)
kept their hard-coded `for (v = 1; v <= 4; …)` / `if (v === 4) break;`. These compile fine and are
**correct for single-instrument docs**, so the full suite stayed green — but they're silent caps that
only bite once a doc actually has voices ≥ 5. The first symptom was subtle: an added instrument played
audio but showed **no playback cursor**, because `findElement(meiId)` (which maps the `playback-position`
echo's meiId → voice) stopped at voice 4 and returned null for the new instrument's notes. Fix: every
all-voices loop must bound on `this.totalVoices()` / `model.totalVoices()`. **Lesson:** when you widen a
union type to an open one, grep for *every* loop/break that hard-codes the old bound — they won't
typecheck-fail and won't suite-fail until the new range is exercised. (Deferring them "until the owning
step" only works if the owning step actually revisits them; here several were missed until hands-on
multi-instrument testing surfaced the playback-cursor gap.)

## A new `Alt+<letter>` voice-mode handler must precede the catch-all modifier bail

The Composer keydown handler (`input.ts`) has a catch-all `if (e.ctrlKey || e.metaKey || e.altKey)
return;` partway down — everything below it is unreachable for any modified key. Adding the `Alt+H`
string-harmonic handler in the natural spot (next to the plain-`H` hide-rest block, which is *below*
that bail) made it dead code: the model method worked when called directly, the keystroke did nothing,
and **nothing flagged it** (typecheck passes, and the suite had no fixture yet). The fix is to place any
new `Alt+`/`Ctrl+` voice-mode handler **above** that bail (the existing Alt+arrow and Ctrl+↑/↓ handlers
are there for the same reason — they even say "must precede the catch-all"). **Lesson:** before wiring a
modified-key handler, find the bail line and insert above it; when a keystroke silently no-ops but the
underlying model op works in isolation, suspect an earlier `return` in the dispatch chain, not the op.

## Composer test visual baselines capture POST-cursor-trace state, not the fixture's end state

A single-part-view fixture asserted (and confirmed) `getCurrentVoice() === 5`, yet its `visualBaseline`
screenshot showed the cursor labeled "V1". Not a bug: the visual invariant runs AFTER the cursor-trace
invariant, which walks the cursor and leaves it at voice 1. The screenshot reflects that post-trace
state, not the state the fixture set up. (Cross-checking live via `composer-inspect` showed the correct
"V5".) **Lesson:** a baseline PNG proves the *rendering* (here: only the violin staff shows) but its
cursor position is whatever the last state-mutating invariant left — don't read fixture-end cursor state
off the baseline; assert it in the fixture's `expr` and confirm interactive behavior with `inspect.mjs`.
See "Test invariants that mutate render state pollute later invariants' pixel reads."

## svg-to-pdfkit ignores Verovio's embedded `<style>` — stroke-only lines vanish in PDF

Verovio strokes staff lines, barlines, and stems via an embedded
`<style>… #<svgid> path,rect,ellipse,polygon,polyline {stroke:currentColor}</style>` block, NOT inline
`stroke` attributes — the line paths carry only `d` + `stroke-width`. The browser applies that scoped
stylesheet on screen, but **svg-to-pdfkit does not process `<style>` selector blocks** (it reads
presentation attributes + inline `style=` only). Result after the PDFKit migration: glyphs (noteheads,
clefs — *fill*-based paths) rendered fine, but every *stroke-only* element (staff/bar lines, stems)
was invisible in the exported PDF. Fix (`inlineComputedStroke` in `save.ts`): with the page SVG parsed
into an **attached** off-screen host (so the scoped style + `currentColor` actually resolve),
`getComputedStyle(el).stroke` yields the concrete rgb per element — write it back as an explicit
`stroke` attribute that svg-to-pdfkit honors. Must run AFTER `forceNonNoteheadBlack` so the resolved
stroke picks up its `color` overrides (non-noteheads → black, colored noteheads → their color).

**Gate the inlining on `stroke-width`, or every glyph grows a gray outline.** The embedded style
strokes ALL `path/rect/…`, but only staff lines / barlines / stems / ledger lines / hairpins are meant
to be *stroke-drawn* — exactly the elements Verovio gives an explicit `stroke-width` (13/18/27/90…).
Noteheads/accidentals/clefs are `<use>` of FILLED `<path>`s in `<defs>` with no stroke-width; inlining
a stroke on them (or the shared defs path) gives every glyph a hairline that antialiases to a visible
gray edge in the PDF (on screen it's sub-pixel and unnoticed). So `inlineComputedStroke` skips any
element lacking a `stroke-width` attribute.

**Lesson:** when porting Verovio SVG to a non-browser renderer, inline what it pulls from the embedded
`<style>` (stroke, font-style/weight on dir/dynam/tempo) from computed style on an attached element —
but inline stroke ONLY where Verovio intended it (`stroke-width` present), or filled glyphs get
spurious outlines.

**Verovio draws `@tstamp` at the NOTE GLYPH for that beat, not the bar-grid x.** A dynam/hairpin at
`tstamp=N` lands exactly on the note at beat N — even in a clef-less measure. The trap that cost a whole
detour: in measure 1 a `tstamp=1` mark coincides with the first note *because the leading clef/time-sig
pushes the beat-1 grid to the note*; in measure 2+ there's no leading block, so it's easy to *assume*
`tstamp=1` renders on the bar line. It doesn't. If a mark looks like it's on the bar line, the bug is
the stored MOMENT being in the wrong measure (`{prevMeasure, beat count+1}` instead of `{thisMeasure, 1}`
— see decisions.md "Expression moments anchor to the cursor's visual measure"), not the `@tstamp`→x
mapping. Measure first with `inspect.mjs` (compare the rendered mark's left to the note's left and the
bar line's left) before "fixing" placement; a render-time inset hack built on the wrong premise just
moved the mark somewhere else wrong.

**Headless Chromium never gives its window OS focus, so `:focus` never matches.** A programmatically
`.focus()`'d element IS `document.activeElement`, but `el.matches(':focus')` is `false` and no `:focus`
CSS (yours or the UA ring) renders — `getComputedStyle` shows `outline-style: none`. So focus rings
**cannot be screenshot/computed-style verified** in `inspect.mjs`/the test harness. Verify the rule is
present and unopposed instead (enumerate `document.styleSheets` for rules targeting the element); it'll
render in a real (window-focused) browser. Don't chase a "missing" focus ring as a CSS bug under headless.

**Verovio emits a leading zero-size positioning `<text>` per control event; read the LATER tspans for
font weight/style.** Inspecting a `<g class="tempo">`/`g.dir`, the first `<text>` is an empty/`font-size:0`
placeholder that reports the element's *default* weight (e.g. 700); the actually-rendered glyphs are the
subsequent `<tspan>`s. Querying `text,tspan` and reading `[0]` gives a misleading bold/normal answer —
filter to elements with real `textContent` and check those.

**Inline `<clef>` changes persist forward across measures (Verovio renders them so), but the model only
tracked the current layer.** `clefAtCursor` scanned just the cursor's measure/layer, so after a clef
change in an earlier bar it fell back to the staffDef default (staff 1 → treble) — wrong for the modal
seed AND any diff-aware redundancy/removal logic. Resolving a clef "in effect" must walk every prior
measure's clefs in the voice's layer (`effectiveClefForVoice`), not just the current one.

**Verovio renders a short measure correctly when `@metcon="false"` is set; no padding, no error (2026-06-03).**
For pickup/anacrusis bars (content summing to less than the meter), set `@metcon="false"` on the `<measure>`
so Verovio skips its meter-conformance check. Spiked before building the API: a 4/4 measure holding a single
quarter note rendered as a narrow bar with the note adjacent to the barline (not padded to full width), and
Verovio raised nothing. The reduced budget itself lives in `hkl:pickup-ticks`, honored by `meterTable.budgetByEl`
so autofill/truncation/placeholder-normalization all use it — don't add a parallel budget path.

**Don't import the model into `notation/beams.ts` — it's a cycle (2026-06-03).** `model/index.ts` imports
`regroupBeams`/`readTimeSig` from `beams.ts`, so `beams.ts` importing the model back (e.g. to reuse
`parseBeatGroups`) is circular. Keep a small local copy of such pure helpers in `beams.ts` (it already has
its own `MEI_NS`; the HKL ns + a 3-line beat-group parser are cheap to duplicate).

**Two playback clocks must agree on per-measure budget — pickups exposed the gap (2026-06-03).** Composer
resolves ticks two ways: the NOTE clock walks element durations + `model.measureStartTick` (budget-aware
via `meterTable.prefix`), while the CONTROL-EVENT clock (tempo/dynamics/hairpins/pedal) uses the doc-based
`absoluteTickForMoment` → `measureTickInfo` in `expressions.ts`. That second walk summed `count*(64/unit)`
per measure and ignored `hkl:pickup-ticks`, so after a pickup the two clocks disagreed by the pickup's
missing ticks — a tempo marked on the first real downbeat applied a beat or two late on playback even
though it rendered in the right place. Fix: `measureTickInfo` honors `hkl:pickup-ticks` too. Lesson: any
new per-measure budget concept must be threaded through BOTH the model budget table AND the doc-based
moment→tick walk, or the audio drifts while the engraving looks correct.

**`getBBox`/`getBoundingClientRect` on an SVG `<text>` returns the font em-box, not the glyph ink
(2026-06-03).** While empirically centering injected accidentals (`heji-render.ts`), measuring a
BravuraText `<text>` glyph's vertical centre with `getBBox()` gave a box whose height was exactly the
font-size (the 1em ascent+descent envelope) — its centre is unrelated to where the sharp/flat/natural ink
actually sits, so the numbers said "slightly low" while the glyph was visibly HIGH. For glyph-positioning
work, measure from rendered PIXELS instead: screenshot via `test/composer-inspect`, find the coloured
notehead centroid (= its staff line) and the accidental's BLACK ink centroid in the column beside it
(excluding the full-width staff-line rows), and compare. Also: in Composer essentially every accidental
goes through the BravuraText injection swap (even plain ±1 sharps with HEJI off), and Verovio's own native
placement of accidentals reads slightly high — so "centred on the line" is a deliberate house offset, not a
bug (see decisions.md). When a screenshot and a measured number disagree, trust the pixels.

**Verovio prepends `data-` to `svgAdditionalAttribute` names (2026-06-03).** A MEI attribute exposed via
`svgAdditionalAttribute: ['note@data-light-color']` surfaces in the rendered SVG as `data-data-light-color`
(and `data-q` → `data-data-q`, `color` → `data-color`). Reading it back off a `g.note` with
`getAttribute('data-light-color')` returns null. When this fed a notehead recolor (`applyNotationTheme`),
the null silently triggered a brightness-filter FALLBACK that looked plausibly bright — so the dark-theme
screenshot looked "fine" while never using the real light color. When you bake an MEI attr to read back off
the SVG, expect the double `data-` prefix; verify by dumping `[...g.attributes]`, not by eyeballing.

**Composer-test fixtures that write `localStorage` pollute later runs via boot state (2026-06-03).** The
`viewModeDropdownSwitch` fixture dispatched a real `change` on `#viewModeSelect`, whose handler persists
`viewMode='scroll'` to `localStorage`. Composer reads that at boot, so EVERY subsequent page load (and the
next full suite run in the same Chromium profile) booted in scroll mode — and `RESET_SNIPPET` reset the
renderer's view mode but not the separately-tracked `#score` `view-*` CSS class, so ~29 visual baselines
silently rendered on the wrong background (`#fafafa` vs the page card `#fff`) and failed with a 93%-pixel
diff that LOOKED identical to the eye (whole-background tint). Fix: `RESET_SNIPPET` now restores the view
class AND clears the persisted view/theme keys. Lesson: when a fixture exercises a handler with a
persistence side effect, reset must undo BOTH the in-memory state and the persisted key, and any state with
two parallel representations (renderer mode + DOM class) must reset both.

**Recolor a Verovio SVG with THREE structural rules, not a per-class list — and never `!important`
(2026-06-03).** Verovio emits an in-SVG `<style>` of the form `#musXXXX path,polygon,polyline,rect,ellipse
{ stroke: currentColor }` (an **ID** selector, so it outranks class rules for `stroke`), sets NO
`color`/`fill` rules itself, renders SMuFL glyphs as `<g class="…"><use></g>`, the brace as `<g><path></g>`,
and lots of structural marks (the system-bracket line, bar lines, …) as **bare `<path>`s directly under
`g.system`/etc with NO distinguishing class**. A per-class recolor list is therefore whack-a-mole — every
review surfaces another unclassed stroked element. The robust recolor is three rules on
`[data-notation-theme="dark"] svg:not(#cursorOverlay)`:
1. `{ color: var(--notation-ink) }` (+ the same on `g.note *`, which re-asserts over the note's own
   `@color` attribute). Verovio strokes everything via `currentColor`, so this recolors EVERY stroke at
   once — staff/ledger/bar lines, the bare system line, stems, braces, slurs, beams, hairpins, tuplet/octave
   brackets — with nothing to keep in sync. Recoloring a stroke can never create a fill artifact, so it's
   always safe and needs no `!important` (Verovio sets no `color` rule to fight).
2. `use, text { fill: … }` — universal glyph + text fill. `<use>` = every SMuFL glyph (notehead, clef,
   accid, rest, flag, sigs, fermata, …), `<text>` = titles/measure-numbers/labels/dynamics/tuplet numbers.
   Neither is ever an open shape, so filling is always safe; no per-glyph class list.
3. `.grpSym, .slur, .tie, .beam, .dots { fill: … }` (+ `*`) — the COMPLETE set of Verovio's filled
   non-glyph shapes (filled `<path>`/`<polygon>`/`<ellipse>`). Every other bare shape is an open stroked
   path, intentionally left out so it shows only its now-ink stroke (rule 1), never a filled triangle/box.
- **Noteheads:** `applyNotationTheme` gives them an INLINE `color`+`fill` (the light-source color, NO
  `!important`). Inline beats the ordinary rules, so they keep their color even though `use`/`g.note *`
  match them; matching inline `color` to fill means their own currentColor stroke draws no ink outline. The
  earlier `!important` stylesheet version was the bug — it overrode the inline notehead fill, so **beamed
  noteheads** (matched by `.beam *`) lost their color. `!important` here is a lazy fix that creates more
  problems than it solves.

**Click-to-select must run the SAME post-move path as arrow nav (2026-06-04).** The click handler
(`click.ts`) moved the model cursor then called a *minimal* `onChange` (reRender + scroll + reference
broadcast only), bypassing the keyboard's `onStateChange`. Two bugs resulted: (1) a click didn't broadcast
`composer-cursor`, so HKL's Composer-view frame cursor didn't follow click-to-select (arrows worked); (2) a
click didn't clear an active range / chord-internal selection or exit to voice mode, so a stale
"alt-selection" lingered (arrows clear it). Fix: extract the keyboard hooks into shared
`composerOnContentChange()` + `composerOnStateChange()` and have BOTH the keyboard and click handlers call
them; the click handler also calls `resetToVoiceMode()` when it places a voice cursor (glyph / empty staff —
NOT when selecting a dynam/pedal/tempo layer element). Lesson: when two input paths (keyboard, click,
drag, …) mutate the same cursor/selection state, route their post-mutation refresh through ONE shared
function — a parallel "lite" version silently drifts (missed broadcasts, uncleared selection).

**A mirrored view's cursor must SHARE geometry code, not reconstruct it (2026-06-04).** HKL's "Composer
view" frame must be pixel-identical to Composer's 50%-scroll view, cursor included. Re-deriving the cursor
geometry HKL-side (anchor edge + staff span) kept drifting from Composer's `cursor.ts` — wrong by the fixed
HPAD/VPAD offsets, wrong height (Composer's insert bar spans the NOTE's box, not the staff), and missing the
sig-end / tuplet / past-end / overwrite-box cases. The fix: extract a single pure geometry function
`computeVoiceCursorRect(anchor, query)` + `computePlaybackBarRect` into `@hkl/shared/cursor-geom.ts`. The
CASE DECISION (which element/edge — needs the model) stays in Composer as `resolveVoiceCursorAnchor`, ships
over the bridge as a render-agnostic `VoiceCursorAnchor`, and BOTH sides compute geometry from it: Composer's
own `cursor.ts` calls the shared fn too (so its drawn bar IS the shared output — verified by the
cursor-trace suite), and HKL's frame calls it with a query over its identical re-render. Because the renders
are pixel-identical and the geometry code + fixed-px constants are the same, the cursors match exactly.
Lesson: to keep two views' overlays identical, share the geometry function and pass a resolved,
render-agnostic spec — never reconstruct the geometry on the second side. (The fixed-px offsets are also why
you can't just scale one render's cursor coords into another: HPAD/VPAD are constant px at any zoom, so the
cursor at 50% ≠ scale(cursor at 100%) — you must recompute at the target render.)

**A mirrored render must use byte-identical Verovio options AND land on an integer pixel (2026-06-04).**
For HKL's Composer-view frame to be pixel-identical to Composer's 50%-scroll view, two things beyond the
score data must match: (1) the Verovio options — the frame's scroll geometry was drifting (pageHeight 60000 +
adjustPageHeight vs Composer's 400, margins 60/40 vs 30, a missing `note@hkl-paren-caut` attr); making
`SCROLL_OPTIONS` byte-identical to Composer's SCROLL_GEOM+BASE_OPTIONS+scale-50 gave the SAME svg dimensions
and element positions. (2) Device-pixel alignment — staff lines looked blurry only in HKL because the frame
box sat on a fractional device-pixel row (`top=…​.594`), so the 1px horizontal lines (anti-aliased under
`shape-rendering:geometricPrecision`) straddled two rows. Root cause was a toolbar button using
`line-height:1.8` (12px×1.8 = 21.6px, rendering to a sub-pixel 21.594), which made that toolbar row 23.594px
tall and offset everything below by 0.594. Fix = integer px line-height on the button (→ integer row →
integer panel top → integer staff rows → crisp). The WRONG fix (which I tried first) was an after-render JS
`transform: translate` snap on the SVG — never patch layout after render; fix the element whose fractional
size shifts the panel. Also mirror Composer's `geometricPrecision` line-rendering CSS on the frame.

**BroadcastChannel drops messages posted before the peer channel exists (2026-06-05).**
`BroadcastChannel` does no buffering or replay — `postMessage` reaches only channels that exist
at post time, and a message arriving before a peer registers its `bridge.on` handler iterates an
empty handler set (also dropped). The HKL↔Composer bridge worked for sequential tab loads (the
later loader's hello reaches the earlier, which replies; even a lost first-hello self-heals via
the reply) but wedged on near-SIMULTANEOUS load — when both tabs post their one-shot hello during
the other's pre-existence window, BOTH are lost and neither re-announces, so the apps sit
disconnected until one is reopened. The common trigger is shared-package HMR (`@hkl/bridge`,
`@hkl/shared`, `@hkl/notation`), which full-reloads HKL + Composer at the same instant. Don't
diagnose this as "the handshake is broken" — it's specifically the double-loss race. Fix without a
retry loop: re-announce on `focus`/`visibilitychange` (debounced), so any drop heals the moment a
tab is focused. → decisions.md "Bridge handshake self-heals on focus, not via retry loop".

**Composer test fixtures leak module state the runner's reset must clear — pendingStopAcks (2026-06-05).**
A new playback fixture passed in `scenario` mode but failed in the `full` suite with `captured=[]`.
Cause: `space_stops_playback` (an earlier fixture) sends `stop-playback`, which increments
`pendingStopAcks`; the test mock never sends the matching HKL `playback-finished` ack, so the
counter leaks. The next fixture's `playback-finished` then hit the `pendingStopAcks-- ; break`
guard and never called `finalizePlaybackEnd` — so no `composer-cursor` was broadcast. `__testReset`
cleared `isPlaying`/`hklConnected` but not `pendingStopAcks`. Lesson: any main.ts module counter a
fixture can leave non-zero (here `pendingStopAcks`) must be reset in `__testReset`, and a
scenario-pass / full-fail split is the tell for cross-fixture state leak — diff the fixture order,
not the code.

### Chromium LNA prompts only AFTER a connection establishes — a closed port is silent

Chrome's Local Network Access (Chrome 142+ for fetch/subresource/subframe; **147+ for WebSockets**)
gates a public/loopback origin reaching loopback behind a permission prompt ("…wants to access other
apps and services on this device"). The non-obvious part, verified against the WICG spec
(https://wicg.github.io/local-network-access/): the permission check is inserted **right after the
connection is obtained and found not-failure** — so a **refused / closed-port connection never reaches
the prompt**. Only an actually-listening endpoint prompts.

Consequences that bit us on the OBS overlay (see decisions.md "drop the off-by-default checkbox"):
- A bare `new WebSocket('ws://127.0.0.1:5190')` is **already a silent presence-probe**. No relay →
  silent connection-refused (a couple of un-catchable `WebSocket … failed` console lines, nothing
  more). Relay up → one prompt, exactly when warranted. So you do **not** need a checkbox/opt-in gate
  to keep non-users from being prompted — just dial unconditionally and keep `giveUpAfter` low.
- A `fetch()`/HTTP **probe is strictly worse**, not safer: it's the one thing that triggers the prompt
  on a *closed* port too. Never "probe first, then connect."
- Firefox doesn't LNA-gate loopback at all; a localhost *origin* → localhost is loopback→loopback and
  exempt. So the whole concern is Chromium-on-a-remote-origin only.
- `navigator.permissions.query({name:'local-network-access'})` reads grant state **without** prompting
  (returns `prompt`/`granted`/`denied`; always `denied` on HTTP) — available if you ever want to gate
  on an existing grant, but unnecessary given closed-port silence.

## Verovio control events (fermata/dynam/hairpin) must follow `<staff>`s in the measure

When building MEI for Verovio, a measure's control events (`<fermata>`, `<dynam>`, `<hairpin>`, `<slur>`, `<lv>`) must be appended **after** the `<staff>` children, not before. Appending a `<fermata>` as an early child of `<measure>` (e.g. while still building the layers) makes Verovio emit *"N time pointing element(s) could not be matched in measure …"* and silently drop the symbol — even though `@startid` resolves to a valid note. Collect control events during the walk and append them in a post-pass once the staves exist (Composer's own `addSibling`/`addSlur`/`addDynam` all append after staves). Surfaced during MusicXML import (`importMusicXml.ts`): fermatas were appended inside the layer loop and warned until moved to the post-pass.

## MusicXML import gotchas (reference: `~/Documents/sonataBr1.musicxml`, Finale v25)

- **`<divisions>` is per-part and can differ** (viola=24, piano=240 in the Sonata). Drive MEI note values from `<type>`+`<dot>` (divisions-independent), not `<duration>`; only use `<duration>`/divisions for tstamp positions and pickup-tick budgets.
- **Measure `number` attributes are not positional** — Finale emits non-numeric ids like `number="X4"` (split measures / number resets). Index measures by document position, never by the `number` string.
- **Dangling ties exist in real exports** — the Sonata has 260 `<tie type="start">` vs 259 `<tie type="stop">` (one unterminated tie). That correctly renders as a single `<lv>` laissez-vibrer stub; it's faithful to the source, not an import bug. Don't chase the lone `lv` warning it produces.
- **Ties cross tuplet boundaries** (a note tied into/out of a triplet). The model's tie realization had to be extended to descend tuplets — see decisions.md "Tie engine: normalizeTies realizes ties across tuplet boundaries".

## Scroll splice: a full render wipes #score's innerHTML (and the old cursor overlay); a splice does not

`main.ts` re-attaches `#cursorOverlay` after every `reRender` but never removed the prior one — it relied on the full-render path resetting `#score.innerHTML` (which deletes the old overlay). The Phase-B2 scroll **splice** edits `g.measure`s in place and does NOT reset innerHTML, so each spliced reRender stacked a NEW overlay on stale ones (the "double cursor overlay" — and the cursor-trace then read a stale, non-moving overlay → `Δ=0,0` violations). Fix: explicitly remove existing `#cursorOverlay`s before appending. Any in-place renderer (no innerHTML reset) must own this cleanup. (`apps/composer/src/main.ts`, reRender overlay block.)

## Verovio defines glyphs as `<g id="E0A4-…">` in `<defs>`, NOT `<symbol>` — and the id salt is per-render

Noteheads/rests/clefs are `<use xlink:href="#E0A4-<salt>">` referencing a `<g id>` glyph def (the id prefix is the SMuFL codepoint; the `-<salt>` suffix is regenerated EACH render). When splicing measures from a sub-render into the persistent SVG, the sub's `<use>` hrefs carry the sub's salt and won't resolve against the persistent defs → the glyphs render **blank** (stems/beams/ledgers, drawn as inline `<path>`, still appear — a telltale "noteheads and rests missing, everything else present"). Merge by **codepoint** (`id.split('-')[0]`): remap each spliced `<use>` to the persistent glyph when the codepoint exists, else copy the sub's `<g>` def over. Querying `<symbol>` finds nothing. (`apps/composer/src/render/splice.ts` `mergeDefs`.)

## Splice spike: measuring invisible `<use>` elements gives garbage geometry

While debugging the blank-notehead bug, the headless metric reported noteheads "off by 440–730 px" — because it `getBoundingClientRect`'d `<use>` glyphs whose href didn't resolve (zero-size/garbage rects). The staff lines + stems were actually fine. Lesson: when a position metric reports wild outliers, check the elements are actually RENDERED (resolve to visible geometry) before theorizing about layout math. The screenshot (opened for Max) showed the truth in seconds where the numbers misled.

## Placeholder normalization must be idempotent — id churn defeats incremental rendering

`normalizePlaceholders` (`apps/composer/src/model/placeholders.ts`) runs on EVERY layer in the doc on EVERY edit (via `normalizePlaceholdersAll`, the choke point ~40 mutation sites reach). It originally stripped and re-appended each layer's trailing `<space data-placeholder>` with a fresh `newId('sp')` unconditionally — so every measure's serialization changed on every edit even when its content didn't. That's invisible while full-rendering, but it **broke the scroll spot-splicer**: its per-measure signature diff saw the whole 446-bar score as dirty on a single-note edit → run exceeded the cap → full re-engrave (~6.3 s, the exact "every edit takes seconds" symptom). Fix: make it idempotent — compute the desired trailing-placeholder decomposition and SKIP the layer if its existing placeholders already match (count + dur/dots + trailing), leaving their ids untouched. Lesson: any document-wide normalization on the hot path must be a no-op when nothing changed — regenerating ids/structure for unchanged content silently defeats anything downstream that diffs by serialized content (splice, undo coalescing, broadcast deltas). (The walk stays O(total) but cheap; the killer was the mutation + downstream re-engrave.)

## Splice: expanding the new run must mirror onto the old run, or measures duplicate

In `ScrollSplicer.splice`, the dirty diff yields a new-index run `[lo..hiNew]` and an old-index run `[oldLo..oldHi]`. `expandForSpanners` then grows `[lo..hiNew]` so whole ties/slurs are re-rendered together — and the OLD run must grow the SAME way: measures before the run align 1:1 (`oldLo = lo`), measures after align 1:1 shifted by the measure-count delta (`oldHi = hiNew + (oldCount − newCount)`). Updating `oldLo` but leaving `oldHi` stale inserts more measures than it removes → a DUPLICATE measure rendered at the same x (looked like "duplication + misalignment in either direction"). The sonata trips this on nearly every mid-score edit because it's dense with slurs/ties. (`apps/composer/src/render/splice.ts`.)

## normalizeTies ran two O(n²) prunes on every edit (the real large-score edit-latency culprit)

`normalizeTies` runs after every structural mutation and calls `pruneDanglingSlurs` + `pruneDanglingArticControls`. Both resolved each spanner/control's anchor by a FULL-doc `querySelectorAll('note,chord[,rest]')` scan **per element** — O(slurs × notes) and O(controls × notes). On the 446-bar sonata (hundreds of slurs/ties/fermatas × thousands of notes) that's quadratic; DevTools showed `normalizeTies` eating ~2.2 s of a 2.7 s main-thread hang on every keystroke-edit. Fix: build the note/chord(/rest) xml:id `Set` ONCE per call (O(n)), then anchor lookups are O(1). (`slurs.ts` `pruneDanglingSlurs`, `articulations.ts` `pruneDanglingArticControls`.) Lesson: this was invisible to render-side profiling — the cost was in the MODEL MUTATION (before reRender), not the renderer. When an edit is slow, profile the whole keystroke (mutation + render), and grep post-mutation hooks for per-element full-doc scans. `normalizeTies` is still O(total) linear per edit (strips/rebuilds all tie state); making it incremental (scoped to the edited region) is the next lever if needed.

## `display:none` on the persistent SVG to skip layout BACKFIRES (full relayout on restore)

Attempt (Phase B3): the splice's `postProcess` runs snap passes on the offscreen host; each `getScreenCTM`/`getBBox` forces a layout flush that (in Firefox) re-lays-out the 190k-px persistent `#score` SVG (`snapBarlines` was ~19% of a ~150 ms delete). Idea: `display:none` the persistent SVG across `postProcess`, restore before `spliceDom`'s bbox reads — the host is `position:absolute` so its geometry is unaffected, and tests confirmed pixel-identical splices. **It ballooned the delete to ~600 ms in Firefox.** Toggling `display` invalidates the ENTIRE subtree's layout, so `display:''` forces a from-scratch relayout of the whole giant SVG; `spliceDom`'s `getBBox` then pays that full layout instead of the cheap incremental one it had. Net far worse (bbx in spliceDom jumped to ~30%). Lesson: never toggle `display` (or anything that drops/re-adds a node from the layout/render tree) on a huge persistent subtree to "save" a flush — the re-add costs a full relayout that dwarfs the incremental flushes you avoided. If isolating layout is the goal, reach for `contain: layout` set ONCE (never toggled), and verify on the real engine — but Chromium can't see this cost (it lays the giant SVG out cheaply), so it needs Firefox to confirm. Reverted; `getScreenCTM` remains the biggest single delete cost.

## Splice must anchor on the LEFT context, and dy must add the anchor's ty (getBBox excludes own transform)

The scroll splicer places the re-engraved run with one `translate(dx,dy)` keyed off an UNCHANGED context measure. Two bugs in the anchor math (`apps/composer/src/render/splice.ts spliceDom`):

1. **Anchored on the RIGHT context** when a measure followed the run. The right-context measure was BOTH the anchor AND the cascade's shift reference, so `delta` computed to exactly 0 → the cascade never fired. The edited run's RIGHT edge was pinned to the (unmoved) right neighbour and its LEFT edge floated: a width-changing edit (delete/insert) opened a gap or overlap with the LEFT neighbour, and nothing after the edit moved. Fix: always anchor on the LEFT context (`anchorIdx = lo>0 ? lo-1 : 0`) so the run's left edge stays joined to its unchanged left neighbour, and the width delta cascades RIGHTWARD. This needs 2 left-context measures (`leftCtx = min(2, lo)`) so the anchor `lo-1` isn't the sub-render's system-first measure (which carries a spurious system-initial clef → wrong width/x). A run at measure 0 is genuinely system-first in both renders, so anchoring there is consistent.

2. **`dy` omitted the anchor's `ty`** while `dx` correctly added its `tx`. `SVGGraphicsElement.getBBox()` returns the LOCAL box (EXCLUDING the element's own transform), so to align to a measure's on-screen position you must add its translate on BOTH axes. The cascade only ever sets `tx`, so a never-spliced measure has `ty=0` and the omission was invisible — until you edited next to a PREVIOUSLY-SPLICED measure (nonzero `ty`, which happens when the sub-render baseline differs from the full render, i.e. varied vertical content), giving vertical misalignment. Fix: `dy = bbx(perAnchor).y + ty(anchor) − bbx(subAnchor).y`.

Guard: `test/composer-test` fixture `scrollWidthChangeCascadesRight` — fills empty mid-score bars (large width change) via the splice path, then asserts every bar's x/y matches a full re-engrave of the same model (≥3px diff fails). Caught the right-anchor bug at 1260px. Lesson: the splice's job is to reproduce the full-render layout exactly; the strongest test is "spliced measure positions == full-re-engrave positions," and the universal invariants (cursor/tie/roundtrip) don't cover splice GEOMETRY.

## Finale encodes string harmonics as diamond noteheads, not `<technical><harmonic>`

When auditing MusicXML import gaps against a Finale v25 export (`sonataBr1.musicxml`), "string harmonics are ignored" turned out NOT to be a `<technical><harmonic>` parsing gap — Finale doesn't emit `<harmonic>` at all (count: 0). It writes the harmonic as `<notehead>diamond</notehead>` on the note. The importer (`importMusicXml.ts`) now reads `<notehead>` and maps `diamond` → `@head.shape="diamond"`+`@head.fill="void"`+`@data-hkl-harmonic` (matching `ComposerModel.toggleHarmonicAtCursor`). Consequence: there's no touched/sounding-pitch metadata to recover — only the notehead shape; the diamond renders, but the artificial-harmonic sounding-pitch inference happens in playback from chord geometry, not from the source. General lesson for import audits: don't assume the *semantic* MusicXML element is present — diff the actual export first; notators often encode an idea through a different, more presentational element than the spec's dedicated one.

## MusicXML beam grouping is reproduced by diffing against our auto-beamer, not by importing `<beam>` verbatim

Composer's live doc is flat (no `<beam>`); beams are recomputed at serialize time by beat (`notation/beams.ts`). To honor a source file's beaming WITHOUT abandoning the auto-beamer, the importer diffs: for each adjacent beamable pair it compares the source's "starts a new beam" (`<beam number="1">` begin/continue/end) against our natural beat boundary (`naturalBeatGroupStarts`) and stamps `@hkl-beam-break` only where they disagree. The key mechanic that makes this work for BOTH breaks and joins: `regroupOneLayer` computes `startsNew = (natural !== marker)` — the marker is XORed with the natural boundary, so a marker at a beat boundary *dissolves* it (cross-beat join), and a marker mid-beat *creates* a break. (Initial misread: that the marker was break-only. It is not.) The result is editable with `/` afterward because it's expressed in the same marker the `/` hotkey toggles.

## spacedPick tie-breaking: a stable sort silently walked S−1, not S

When `pickSamples` gained a configurable spacing, decay-path picks landed every 2 semitones instead of the configured 3 (49 analyzed → 25 picked instead of ~17). Cause: within each `±HALF` window the picker sorts by `tiebreak` (tier, then segment count, then steady seconds) — and on the decay path **every metric ties** (no segments, no steady stats), so the stable sort preserved midi order and always chose the *lowest* midi in the window, i.e. `target − 1`. The walk then advanced from `best.midi + S` = `target + S − 1`. Fix: break full ties by distance-to-target, then midi. Loop-path outputs are unaffected in practice (float `steadyDurSec` almost never ties) — verified byte-identical on the regression baselines. Lesson: any "pick best in window, advance from pick" walk needs an explicit distance tie-break, or systematic bias in the candidates compounds into a different effective stride.

## Analysis `transpose` ≠ runtime `transpose` — don't let the label convention reach the engine

The analyzer config's `transpose` is *filenameLabel ÷ audioFundamental* (2 = files labeled an octave above their audio, à la FatBoy drawbar / MQ double bass; 0.5 = the inverse, à la Splendid piano). It steers the pitch-detector seed and the emitted `freq` (= actual fundamental). The engine's `instr.transpose` is a *rate multiplier* (`rate = freq·transpose/nearest.freq`). `bundle.js` used to copy the former into the manifest, and `manifestToInstrument` feeds manifest.transpose straight into the engine — so any bundled config with transpose ≠ 1 would play whole octaves off. It never fired only because every previous local/bundled config had transpose 1; `emitBlock` (samples-data path) never emitted transpose at all, which is why shipped CDN instruments were immune. The tell that labels are octave-off: mass `no fundamental at labeled freq ±5%` fails on an instrument whose neighbors analyze fine.

## `link:` deps into a git-ignored `dist/` break fresh-clone recursive builds

`test/react-consumer` depends on `"@hexkeylab/engine": "link:../../packages/engine/dist"` — a symlink into a build artifact that only exists after the engine's tsup build. Locally that's invisible (the dist is usually built); on any fresh clone (Netlify) the link points at nothing and the package's `vite build` dies with `Rollup failed to resolve import "@hexkeylab/engine"`. pnpm gives `link:` deps no topology edge either (the name `@hexkeylab/engine` isn't a workspace package), so build order can't save it. Fix: test packages don't belong in the production recursive build at all — root `build` is now `pnpm -r --filter='!./test/**' build`; the react-consumer gate stays self-contained (`run.mjs` builds the engine, then itself). General rule: anything `link:`ing a git-ignored artifact must own the build of that artifact in its own entry point, and must not be reachable from a deploy's `pnpm -r`.

## Firefox fractional-rate sources emit pre-ring BEFORE their scheduled start — never create a crossfade gain node at the default value

Symptom: every segment-looped instrument clicked at loop seams in Firefox ("crackling on chords"), including analyzer-green instruments, while Chromium was clean — and the same seams rendered click-free from the analyzer's PCM. Cause chain, isolated by rendering the exact engine schedule in both browsers' OfflineAudioContext: at `playbackRate ≠ 1`, Firefox's `AudioBufferSourceNode` emits ~3–4 samples of resampler pre-ring *before* its scheduled `start(when)` moment; a freshly created GainNode has the default value **1** until its first automation event (`setValueAtTime(0, switchTime)`) takes effect, so the ring passes at full level and is then truncated to zero at the seam — a discontinuity proportional to the waveform amplitude at the seam entry point ("clicks of varying loudness"). Sample-rate conversion alone (44.1k buffer on a 48k context at rate 1) does NOT trigger it; only fractional `playbackRate` does — which HKL/MQ playback uses on essentially every note (JI + minor-third-thinned samples). Fix: initialize every future-scheduled gain to silence at creation (`g.gain.value = 0` before the events) — applied at all five sites (sNoteOn segGain, scheduleSegmentSwitch, doImmediateSwitch, sNoteOnFaded, segmentLooper). Verified: worst Firefox seam went from +13.4 dB above baseline to 0.0 dB.

Debugging lesson: when "the analyzer must be wrong" — first render the analyzer's own output through the exact runtime schedule *outside* the runtime. Here that exonerated the data in one pass (all seams clean in Node and Chromium) and turned the hunt from a discriminator audit into a two-variable browser bisection (browser × playbackRate), which converged in three experiments.

## Loopability is predicted by vibrato + solo, not by instrument family

The oboe wall (all 8 sources failed, per the earlier entry) turned out to be a property of the *recordings*, not the instrument: every failed source was straight-tone (Iowa ff, VSCO-2-CE "Sus" = explicit no-vibrato) or soundfont-rendered. The MQ english horn — also a double reed — loops green *because* its samples have vibrato: periodic FM gives the vibrato path's phase matching something to lock onto, while straight-tone double reeds expose only aperiodic breath-noise micro-variation. Probing VSCO-2-CE's untried **Vib** articulations confirmed it across the board (2026-07-09, all under the −10 dB residual gate): oboe 8G/1Y, solo violin 12G, flute 10/10G, solo contrabass 9G. The complementary failure: **section/ensemble recordings are unloopable regardless of vibrato** — VSCO's Cello Section susvib went 12/13 red (decorrelated multi-player phase never repeats), the same class as the MQ cello. Philharmonia's *solo* cello (arco-normal, 1.5s bucket ≈ 2.1s files) passes with 16 picks. Sourcing rule of thumb: **solo player + natural vibrato + ≥2s sustains = loopable; straight-tone, ensemble, or synthesized = expect red.** License note: VSCO-2-CE is CC0; Philharmonia is free-for-commercial-work but forbids redistribution "as is (as samples or as a sampler instrument)" — a hosted .hki of their samples is a gray area to resolve before shipping.

## Wet (reverberant) vibrato is unloopable — the missing clause in the loopability rule

The SSO solo violin's low-mid reds (A#3/C#4/G4, the 2026-07-09 regen's G3→E4 hole) were fully diagnosed by a scratchpad harness that imported `@hkl/analysis` directly and reproduced the shipped picks byte-identically (2026-07-10). The gates were vindicated end-to-end: every surviving pair in every vibrato sample sits at an integer multiple of the vibrato period (the 5¢ pitch-step gate doing its phase-alignment job), and the phase-matched pairs that get killed *deserve* it — their hypothetical seam residuals sit at **+1…+2 dB** (vs the −10 dB gate), so no threshold relaxation rescues them. Vibrato in the failing notes is textbook-regular (5.0 Hz, period CV 0.07–0.11), killing the "irregular vibrato" hypothesis.

Root cause, proven by same-take comparison: SSO's published Violin folder is the raw ldk1609 takes **mastered with wide decorrelated stereo reverb** (steady-region L/R Pearson: raw take **0.961**, published C#4 **−0.025**) plus a ~4.5 dB HF boost. Reverb is LTI, so a straight-tone input still yields a periodic output — which is why SSO's non-vib G3 loops green under the identical mastering — but with 5 Hz FM the ~0.5 s reverb memory superimposes the recent pitch trajectory onto every instant, and since vibrato period jitters 7–11% cycle-to-cycle, the waveform never repeats even at matched vibrato phase: adjacent-cycle residuals are p50 **+1.7…+3.4 dB** published vs **−19.4 dB** raw. The same performance loops 6-segment green from the raw file (`Violin 2/violin_arco_vib_c#3.wav` → 6 seg, −14.1 dB @ 8 ms; full chromatic probe of the raw folder: 33G/3Y/5R).

Refined sourcing rule: **solo + natural vibrato + ≥2s sustains + DRY.** Quick wetness probe before committing to a source: steady-region L/R correlation — near 1.0 = mono-compatible/dry (loopable), near 0 = decorrelated reverb (vibrato notes will red out). Fallback for a lopsided-reverb source: single-channel decode of the drier channel (published C#4 R-only: 2→4 segments) — inferior to finding dry samples. Secondary observation from the same probe round: Philharmonia's solo violin 1.5s bucket (files 1.6–2.8 s, steady 1.1–1.7 s) went 36/49 red where their solo cello at the same bucket passes — at violin register the short bucket leaves too little steady material; don't assume a source family that worked for one instrument transfers to its siblings.

## MusicXML clef-change import: before the barline = end of the PREVIOUS measure, and it must be in every content layer

Two non-obvious Verovio facts, found reproducing a Finale import bug (measure 75: bass clef shown but notes drawn as if treble, ledger-line explosion):

1. **An inline `<clef>` in ONE layer does not reposition notes in the OTHER layer.** If a staff's notes are in layer 2 (voice 2) but the clef change is inserted only in layer 1, Verovio draws the new clef glyph yet keeps the layer-2 notes at their old-clef staff positions. Fix: insert the clef into *every content layer* of the staff (duplicate glyphs at the same x coincide into one). An in-section `<scoreDef><staffDef>` change also governs all layers, but the Composer model (`effectiveClefForVoice`) only tracks head-`staffDef` + inline clefs, not in-section `staffDef` changes — so inline-in-all-layers keeps model and render consistent.

2. **A clef change effective at a measure boundary renders BEFORE the barline only if the `<clef>` is at the END of the outgoing measure's layer.** A clef at the *head* of the new measure's layer — and an in-section `staffDef` between the measures — both render *after* the barline (Verovio's default). The engraving convention (Gould) is before the barline. Rather than special-case this in the importer, it's a **global render-clone pass** `relocateInitialClefs` (model/index.ts, run in both serialize paths): the live doc keeps clefs at measure heads (natural for cursor/editing), and on render each measure-initial `<clef>` moves to the end of the previous measure's same staff+layer. Global → native clef edits get it too. Verified by rendered clef-x vs barline-x in the headless harness. Invariant: a barline is never immediately followed by a clef.

## An `<mRest>` needs the placeholder-fill and placeholder-invariant to treat it as a full measure, or it renders as a double-whole (breve) rest

An empty imported bar (`<rest measure="yes"/>`) becomes a single `<mRest>` — Verovio's centered whole rest, meter-agnostic (the conventional empty-bar glyph). But the Composer model's tick math doesn't count `<mRest>` (it's not in `contentChildren`, and `realTicks` has no case for it → 16-tick fallback). So `normalizePlaceholders` saw the layer as underfull and appended a `<space>` placeholder next to the mRest — and Verovio, seeing `mRest` + a `space`, sized the bar as a **double-whole (breve) rest** ("double whole rest destroying alignment"). Fix: `normalizePlaceholders` treats a layer containing an `<mRest>` as full (no placeholder), and the composer-test `assertPlaceholderInvariant` skips mRest layers (full by definition). `<mRest>` isn't a cursor stop (not in `layerStops`/`contentChildren`), so an mRest layer is treated as an empty voice — consistent with the existing empty-measure nav model (the measure wrapper is the stop). (SMuFL gotcha that cost time here: `E4E3` is `restWhole`, `E4E2` is `restDoubleWhole` — off-by-one in the codepoint table sent me chasing a phantom breve.)

## MusicXML slur/wavy pairing is per-PART, not global-by-number

Slur `number` (and `<wavy-line>` number) is unique only within a part — it's reused across instruments. Pairing open/close globally by number across the whole document mismatched a piano-staff slur start with a viola slur close (a slur that "crossed to the viola part, which makes no sense"). Cross-*staff* slurs (piano treble↔bass) ARE real and must pair across a part's staves/voices — so pairing is scoped per part (composite key `partIdx*1000 + number`), global within a part but never across parts. Same for trill-extender wavy-lines.

## "Does this layer have content?" must count `<tuplet>`/`<fTrem>`/`<bTrem>`, not just note/chord/rest

A mid-measure clef change over a tripleted voice (sonata m193: piano staff 2 switches to treble on beat 2, a voice made entirely of triplets) silently vanished. Cause: the importer's `layerHasContent` — used to pick which layers a clef is inserted into — tested only `note|chord|rest`, so a layer whose only children are `<tuplet>` wrappers read as "empty" and was excluded, dropping the clef. Fix: include `tuplet`, `fTrem`, `bTrem` (mirror `contentChildren` / the placeholder-invariant's tick list). General rule: any "is this layer/measure empty?" predicate in Composer must treat tuplets and tremolo wrappers as content — their notes are nested, so a shallow `note|chord|rest` scan misses them.

## Finale encodes a hidden rest as `<forward>`, not `<note print-object="no"><rest/>`

A voice that enters mid-bar (sonata m.65: piano upper staff voice 2 starts on beat 3) is written by Finale as a `<backup>` to the bar start followed by a **`<forward>`** (a bare `<duration>`+`<voice>` with no notehead/rest glyph) — an *invisible* time advance. `print-object="no"` in this export only ever appears on `<staff-details>`, never on a rest, so "hidden rests" don't come through as rests at all. The importer's `buildEvents` originally iterated `children(measureEl, 'note')` and so **ignored `<forward>` entirely**, collapsing the gap: the voice's real notes shifted to beat 1 (displacement). Fix: walk the measure's children in document order and translate a voiced `<forward>` into a **hidden rest** (`<rest visible="false">`, beat-decomposed via `beatAlignedRestEvents`) — the Composer's existing hidden-rest form (the `H` toggle; Verovio ignores `@visible`, CSS hides it). Occupies ticks, draws nothing, keeps the following notes in place. Gotchas: the forward's `<duration>` is in the part's MusicXML divisions (convert `dur*16/divisions` to MEI ticks — needs the *effective* per-measure divisions, not `part.divisions`); a `<forward>` without a `<voice>` is ambiguous per-voice, so skip it (all real ones in the sonata carry a voice). This file has only **4** `<forward>` elements total — rare, easy to miss, but each one silently corrupts a measure. Explicit `<rest>` elements are `<note>` children and were always imported fine (as *visible* rests) — only the invisible `<forward>` gaps were lost.

## Finale movement boundaries are final barlines, not double bars

Importing the viola+piano sonata, the intuitive assumption ("a double bar separates the movements") is backwards. In Finale's MusicXML the four movement ends are `<bar-style>light-heavy</bar-style>` (**final** barlines) — accompanied by `<print new-page="yes">` + a displayed measure-number reset (`text="1"`) + a Roman-numeral `<credit>`. `light-light` (**double**) barlines are used ~18×/part as *internal* section dividers **within** movements. So the importer puts a movement/section break at each mid-piece **final** barline, not at double bars; double bars import as plain `@right="dbl"`. Distinguishing signals: a `light-heavy` that also carries `<repeat direction="backward">` is a repeat end (`rptend`), not a movement boundary; the very last `light-heavy` is just the piece's final bar (no break after it). Also: Finale writes the movement-ending bar as a short `implicit="yes"` "X" measure containing a mid-measure `light-light` immediately followed by the terminal `light-heavy` — `scanMeasureBarlines` takes the terminal right barline, so the movement end reads as `end`, not `dbl`. (Consequence: the raw `dbl` count after import is *source double bars minus the movement-end ones* — 18→15 in this file, which is correct, not a dropped-barline bug.)

### Arch's npm package can silently lose `npm publish` (missing bundled `sigstore`)

`npm publish` failing with `Cannot find module 'sigstore'` is NOT a project problem: `libnpmpublish/lib/publish.js` top-level-requires `./provenance` → bare `require('sigstore')`, and Arch's npm package (seen on npm 12.0.0-1, 2026-07-24; recalled once before) prunes bundled deps and dropped bare `sigstore` while keeping scoped `@sigstore/*`. Every publish crashes, provenance flags or not, and `pacman -Qkk npm` reports 0 altered files because the package itself is broken. It recurs with system npm package updates and clears when Arch ships a fixed one. Workaround that avoids npm entirely: `cd packages/engine/dist && pnpm publish --no-git-checks` (pnpm's own publish path; the publishable manifest is `dist/package.json` — the workspace `@hkl/engine` is private). One-off alternative: `npx npm@latest publish`. Related gotcha: the published VERSION is `const VERSION` in `packages/engine/tsup.config.ts`, not the workspace package.json — a bump that misses it publishes the previous version.

## AudioParam `.value =` is dead the moment the timeline has (or will get) events — deferred-setter hosts resolve the pre-event region from the CONSTRUCTOR default

HKLE is bring-your-own-`AudioContext`, and react-native-audio-api 0.13.2 diverges from the spec twice: the `.value` setter is deferred (queued to a control thread, not applied), and evaluation at times before the first scheduled event resolves from the param's *constructor default* (1.0 for gain/playbackRate) — never the intrinsic value. So the born-silent idiom `g.gain.value = 0; g.gain.setValueAtTime(0, futureT)` renders the source's first sample at unity gain: one raw-buffer sample injected per source start (note-on + every seam). Audibility tracks how far the segment entry sits from a zero crossing, which disguised an all-instruments bug as a one-instrument bug (winds enter at ~±0.0005 → inaudible; cello at ~−0.06 → click per seam). **No browser reproduces this** — Firefox/Chromium implement the spec's intrinsic-value fallback — so no web test can catch the class; it was found and verified on-device via Intonalogy (`handoff/hkle-born-silent-gain-fix.md`, fixed in engine 2.4.1, ~50 defects/10s → 0). The rule now enforced across the engine: every `.value = x` write where `x` can differ from the param's default gets a paired `setValueAtTime(x, 0)` — the t=0 seed is always the earliest event, so the timeline is authoritative from birth; harmless on spec hosts. Writes intended at the default (voiceGain etc. = 1.0) are exempt — the wrong lookup returns the right value there. Same-class trap to watch for in review: a param created with only `.value = x` that *later* receives future-scheduled events (segmentLooper's `g0` fade-out was this — the whole pre-switchTime region would have rendered at 1.0, not one sample). Sibling lesson: "Firefox fractional-rate sources emit pre-ring BEFORE their scheduled start" — the two host quirks together are why born-silent gains need BOTH the intrinsic write and the t=0 timeline seed.

## segGain carries BOTH the voice's attack and the seam events — never anchor a cancel/restore on it at `now`

A voice's `segGain` timeline holds two unrelated event families: the birth attack (sNoteOn's 4ms `ATTACK_FADE_S` ramp / sNoteOnFaded's 100ms equal-power `setValueCurveAtTime` at `[startT, startT+dur]`) and the pre-scheduled seam events (`setValueAtTime(v.vol)` + ramp-to-0 at `[switchTime, switchTime+xfDur]`, always later). Every looping voice carries a `pendingSwitch` from birth, so "the voice is surely in sustain by now" is false for any voice released, retuned, or slurred within its attack window — and with lookahead scheduling, for *every* future-scheduled voice at the moment of a retune sweep, no matter how far ahead its onset is (the damage anchors at `now`, not at the voice's `startT`). `cancelPendingSwitch` did `cancelScheduledValues(now)` + restore-to-`v.vol` and thereby deleted or corrupted pending attacks from every teardown path (`sNoteOff`/`sHardStop`/`sRampFreq`/`sSlideAndFadeOut`/`scheduleSegmentSwitch`) — fixed in 2.4.2 by cancelling at `p.switchTime` (removes exactly the seam events) and skipping the restore when the crossfade never began. The rule: to undo *specific* future events on a shared param, cancel at *their* anchor time; `cancelScheduledValues(now)` is only safe on a param whose timeline you own exclusively (e.g. `voiceGain`, which carries only the release).

## Hosts diverge on `cancelScheduledValues` vs an in-flight `setValueCurveAtTime` — strict hosts throw, Chromium silently snaps

Firefox (152) and react-native-audio-api keep a curve event whose start time is before the cancel time, and then *any* event scheduled inside its `[T0, T0+dur)` span throws `NotSupportedError` ("Can't add events during a curve event" / "conflicts with an existing curve event"). Chromium removes the in-flight curve entirely, so the same code doesn't throw — the value just snaps to the pre-curve level. Consequence for testing: one engine bug can present as a hard throw on Firefox/native and as a silent audible defect on Chromium (this is exactly how hkle-cancel-pending-switch-attack showed two symptoms). A Chromium-only harness proves the audio damage but can NEVER catch the throw class — verify anything that schedules events near a live curve on Firefox too. Also Gecko still lacks `OfflineAudioContext.suspend()`, so Firefox-side checks need a real-time `AudioContext` (the scratch repro's `-rt` scenarios) rather than offline suspend-point driving.


## Perceptual audio gates: measure what the ear hears, at the ear's scale (2026-08-18)

Condensed from the Intonalogy cello rebuild (full story: docs/analyzer-perception-handoff.md §3–§6; decisions.md 2026-08-17/18). The recurring failure shape was optimizing a proxy the ear doesn't use:

- A click metric (crossfade residual) cannot see bumps/wahs — energy redistributed BETWEEN partials is invisible to a waveform difference.
- Phase metrics are blind to PRESENCE: a flat trajectory has no phase (pre-vibrato seams passed every Δφ gate). Depth/ratio is its own dimension.
- Correlation cannot distinguish vibrato from bow jitter (both common-mode across harmonics); RATE AGREEMENT across independent harmonics can. Depth = sinusoid-amplitude-at-rate, never track std (tracker noise inflates std).
- Envelope windows must respect the carrier (≥4 periods or you sample per-cycle ripple), partial windows must resolve the partial SPACING (≥3 cycles of f0 or "per-partial" is band mush), and fundamental-locked pitch tracking dies on weak-h1 strings (lock to the strongest harmonic; cents are harmonic-invariant).
- Normalize against the LOCAL context the ear compares against (an onset's own p90, a neighbor median) — steady-region references are apples-to-oranges for onset defects, and single-window admission samples beating partials at their dip (measure max over the span, A-weighted).
- Some defects exist only set-relatively (a 5 ms attack among 70 ms swells; ±2¢ vibrato among ±7¢ neighbors): no single-sample scalar finds them.
- Gate architecture: admission bars only catastrophes, ordering + pruning minimize, and thresholds that never touched an ear are suspect — the legacy 1% amp gate (0.09 dB!) silently caused a years... months-long 3-segment ceiling.

## A ranking signal folded into a shared helper becomes a gate (analyzer pick bar, 2026-08-18)

`pickSamples`'s `worstSeamSeverity` once folded `_setOutlierSev` in "so the tiebreak sees it" — but the same helper fed the sub-red pick BAR and the coverage pass, so sub-demotion set-deviation (including the source-LEVEL term that is inaudible post-normalization and must never gate) hard-barred notes from picking, directly contradicting the comment three lines above it and perception-handoff §7. Caught on FluidR3 trombone, where engineered loops make pure seam severity ~0.02–0.07 set-wide: G3/C2/Bb2 were barred purely on set-deviation (0.30–0.39). The design intent — deviation ranks, only its own ≥0.4 demotion deletes — needs the gating path and the ordering path to read *different* values; when a helper serves both, every signal added to it silently becomes a gate. `HKL_PICK_DEBUG=1` now prints the blip/setdev/attack/brightness/vibrato decomposition per note, which is also the cheap screening readout for candidate soundfont coherence.

## Tail-less sources: segment selection must own the end-of-file margin (trombone Db2, 2026-08-18)

FluidR3 renders run hot to the very last sample — no decay tail — so the steady region extends to ~EOF and perception mode's quality-first ordering (which favors LONG segments) placed five trombone picks' seam `b` within 33–47 ms of the physical end. The engine needs audio past `b` for the crossfade tail, and decode lengths legitimately disagree across decoders (mp3 frame granularity ~26 ms, the +529-sample stream-copy cut shift, gapless-header handling) — Db2's wrap landed past the browser's decoded end and the loop died permanently. Two compounding holes: (1) no admission constraint tied `b` to the buffer end — the bundler's tail cut carries a 100 ms margin *past the last playable point*, which silently assumed selection had left room it never promised; (2) the xfade-residual gate returns −Infinity ("nothing to compare") when the window runs off the buffer — a gate that answers "can't measure" with a PASS is a hole exactly where measurement matters most. Fix: `rejectByTailMargin` in `selectSegmentsCore` bars any refined `b` above `len − (crossfade + 100 ms)`. The legacy pipeline never surfaced the class (v1 shipped set: zero segments within 150 ms of EOF) — the throttling gates it retired were accidentally load-bearing here too. Long-tailed sources (Philharmonia cello: every pick ≥150 ms margin) never exercise this; audit any tail-less/rendered source for it.

## A bounded-band fraction measure degenerates when the energy lives outside the band; a fallback that returns plausible units is worse than null (attackTonalLagMs, 2026-08-18)

`attackTonalLagMs` ("time until harmonics hold >60% of total energy") capped its harmonic sum at k ≤ 6. At trombone Eb2 (f0 78 Hz) that band spans 78–467 Hz, where a bright forte note keeps ~30% of its energy — the fraction never crossed 0.6 *even in sustain*, and the metric silently fell back to reporting the steady-region start (~600 ms). Every low-zone note "measured" a huge attack lag; the set-relative gate then manufactured a 585-vs-135 ms attack cliff at the zone boundary that Max's ear correctly contradicted (the low-zone onsets are FAST and aggressive). Two generalizable rules: (1) any fraction-of-total measure with a bounded band must scale the band with the material — cap harmonics by FREQUENCY (k·f0 up to ~3 kHz, min 6), never by count, or the measure means different things at different pitches; (2) when a measure cannot produce its answer, emit null — the fallback returned a number in the right units with a plausible magnitude, indistinguishable downstream from a real measurement. Nulls are skipped by the set-relative median and gate; masquerading numbers poison them. (Same principle the onset-blip gate already followed: onsets too short to have a middle emit null.)

## Under command-cadence retuning, the seam scheduler's now+5ms clamp splices past the validated pair — a dip class no step detector sees (inflight-crossfade-cut repro, 2026-08-25)

Every `sRampFreq` call cancels + reschedules the pending seam; `scheduleSegmentSwitch` clamps `switchTime = now + 5ms` when the natural wrap is closer than that. A retune call landing within 5ms of a wrap therefore starts the crossfade AFTER the old source has played past its validated `b` — the fade splices phase-unvalidated content against an `a` that was validated for `b`. Measured on strings.hki (Chromium, real-time 44.1k): seam-dip floor (30ms fade RMS vs ±flanks) degrades from 0.807 on an undisturbed hold to 0.553 at 20ms call cadence and 0.500 at Intonalogy's 40ms cadence, and the ten deepest dips all sit at call→fade gap = exactly 5.0ms; one long ramp per gesture shows zero degradation (0.807 = clean floor). Two consequences: (1) the audible "clicks while tuning" on web are this dip class, not the stale-gate stop() race the handoff hypothesized — host-independent, rate ∝ command cadence, which is why the consumer's 40ms throttle workaround makes it worse; (2) a single-sample step/impulse detector is BLIND to it (energy redistribution, the perception-work lesson again) — measure it as seam-local RMS dip vs flanking windows, keyed off `onSeamEvent` commit times. Repro + measurement: `test/ramp-stress/run.mjs` (`cadence-*` scenarios) and the seam-dip comparison in decisions.md 2026-08-25.

## Desktop Chromium closes the JS-clock-vs-render race at seam boundaries; hammering a boundary defers it instead of hitting it (2026-08-25)

Two hard-won facts about racing `ctx.currentTime` against pre-scheduled seam events. (1) The hypothesized race — JS reads `now < switchTime`, takes the cancel path, `stop(0)` cuts a fade the render thread already started — did not occur ONCE on desktop Chromium across 60 single-shot snipes (19 of them with the clock read inside the final quantum before switchTime, down to 0.03ms), 3000 blind 20ms-cadence calls, and sub-ms hammering: a stop command posted while JS still reads pre-switchTime reliably beats the fade block's render (currentTime publishes only after a block renders, and control messages drain before rendering — the danger window is at most the callback's compute span). Treat the race class as HOST-DEPENDENT: a deferred-command host (react-native-audio-api queues even `.value=` writes) can hold a wide window where Chromium holds none — a web null is not a native null. (2) Hammering calls across a boundary to force the race is self-defeating in this engine: every pre-boundary call reschedules the seam and the now+5ms clamp shoves the boundary ahead of the hammer, so the fade never starts under it (and each shove IS the dip bug above). The maximal-odds probe is one phase-aligned call per seam, fired one quantum after an observed currentTime flip (`r2-snipe` in test/ramp-stress).

## Verovio setOptions + redoLayout does not reliably re-apply layout options — loadData is the only trustworthy relayout (Composer zoom/view-switch, 2026-08-29)

The documented resize idiom (`setOptions(newOpts)` then `redoLayout()`) looked like a free win for option-only re-renders on an unchanged document (zoom presets, view-mode switches): skip the MEI parse/convert (~1.25 s of the sonata's 4.5 s page render) and relayout in place. Disproven by the headless probe the same day it was written: after a scroll-mode layout, `setOptions(page geometry)` + `redoLayout()` produced **2 pages instead of 37** — the relayout kept scroll's 100000-unit page rectangle, so the new `pageWidth`/`pageHeight` never took; and a zoom-preset relayout (`scale`+`unit` change) returned in **0 ms**, i.e. a silent no-op, while the drawn output scaled anyway — meaning `scale` is applied at draw time but the crisp preset's `unit` change (which must reflow spacing) likely never re-laid-out. No error, no console output either way — the failure is only visible by asserting on the OUTPUT (page count, SVG width), which is why the probe asserts those alongside timings. Verdict: on the CDN build ("latest"), treat `redoLayout` as unreliable for any cross-geometry or preset change; every option change that should reflow must go through `loadData`. The shortcut was reverted (see the DEAD END comment in `apps/composer/src/render/render.ts` and composer-render-perf.md T1.3); zoom's real fix is drawing fewer pages (T2.1), not skipping the parse.

## Deferred renders tear the UI unless every visible flip travels with the content swap (Composer view switch, 2026-08-29)

T2.2 made heavy renders deferred (badge paints, engrave follows a frame later). The first regression it exposed was not in the new code but in an OLD call site's ordering assumption: `applyViewMode` flipped the `#score` view-mode CSS class synchronously and "then" rendered — fine when the render was synchronous, torn when it wasn't: the container restyled to the scroll layout around the still-page DOM for the entire multi-second engrave. The fix is a rule, not a patch: once any render path can defer, **no user-visible state (CSS classes, container attrs, visible geometry) may change at request time — every visible flip moves into the render body, in the same synchronous block as the DOM swap**, so the browser commits them as one paint. Audit for this class whenever a new eager mutation precedes `reRender()`: the tell is "set visible thing, then reRender" in a handler. (Theme escaped it only because T1.1 made theme changes render-free; zoom escapes because stale-but-consistent old content is acceptable behind the badge.)

## Two measure coordinate systems — allMeasures vs section-direct-children — and <ending> splits them: silent stale scroll-splices (2026-08-30)

The model (allMeasures(), voice index, cursor machinery, dirty ranges) counts measures in DOCUMENT ORDER — `querySelectorAll('measure')`, volta measures included. The scroll splicer and `serializeRangeForRender` count DIRECT `<section>` children — `<ending>`-wrapped measures excluded. On the sonata (2 volta measures at doc indices 36/37, so a constant skew of 2 after them), this produces two confirmed silent-staleness classes, probed live 2026-08-30:

1. **Post-ending edits splice stale.** A B3-converted mutation (insert/delete) reports its dirty range in model coords; the splice consumes it in direct-children coords, re-serializes the WRONG window, reuses the cached signature for the measure that actually changed, and concludes "nothing changed" — zero toolkit calls, SVG untouched, no warning. Confirmed by flipping `__HKL_INDEX_CHECK` in-page: the dirty-coverage gate throws `dirty-range too tight` for any converted edit past the voltas, and stays silent before them. Unconverted mutations escape only because they reset dirty to `'all'`. No fixture has an ending + post-ending converted edit, which is why 328/328 never caught it.
2. **Edits inside a volta measure splice stale unconditionally** — the measure isn't in the splicer's order/sig maps at all, so even dirty `'all'` can't surface it (confirmed: real model deletion in the volta, splice did zero work). Implied by the same code path, untested: the width-change cascade iterates the direct-children order, so volta measures would also SKIP the x-translate and overlap their shifted neighbors.

**FIXED 2026-08-30** exactly along that line: one document-order coordinate system (splicer order/sigs/cascade via `sectionMeasures`, `serializeRangeForRender`/`cloneRangeStructure` with ending-aware wrapper cloning, `runningScoreDefContext` doc-order walk), runs expanded to whole endings incl. context slots (`expandForEndings`), and — found by the new fixture — Verovio's `g.ending` bracket group is a SYSTEM-level glyph the measure imports never carry, so the splicer now reconciles it by id (replace from sub, drop orphans, cascade downstream with its measures). Regression fixtures `scrollSpliceAfterEnding` / `scrollSpliceInsideEnding` fail on the pre-fix code and pass now; probe-confirmed on the sonata. The Phase C page-splice index must adopt the same convention from day one — and reconcile `g.ending` groups too. Note the model side was never broken: navigation and editing inside voltas work (an earlier "unreachable" diagnosis was a probe bug).

## tstamp-anchored spanning elements are invisible to expandForSpanners — an edit at a hairpin's host measure deletes the wedge from the spliced SVG (2026-08-30)

`expandForSpanners` grows the splice run by resolving `@startid`/`@endid`; our expression layer deliberately anchors dynamics/hairpins by `@tstamp`/`@tstamp2`, which resolve to nothing — so a multi-measure hairpin never expands the run. Confirmed with a synthesized 3-measure crescendo: editing its HOST measure re-renders a sub-range whose `tstamp2` target lies beyond the range — Verovio logs only a console WARNING ("time spanning element(s) with timestamps could not be matched", below the test suite's error-level CONSOLE invariant) and drops the wedge, and the un-reserved spacing also collapses the host measure's width (1176 → 379 units) — the splice transplants both errors into the persistent SVG. The complementary case (edit under the wedge's TAIL with the host outside the run) reproduced cleanly only because the available probe edits were width-neutral; a width-changing tail edit would cascade the measures under a wedge glyph that never moves. **FIXED 2026-08-30**: expandForSpanners resolves `tstamp2="Nm+B"` (host measure index + N, clamped) and treats the element as spanning [host, host+N]; `pedal` added to the spanner selector for future spans. Regression fixture `scrollSpliceHairpinHostEdit` fails on the pre-fix code and passes now. The sonata itself contains only `0m` wedges — Composer-authored cross-measure hairpins are where this bit.

## Verovio smart castoff silently ignores an <sb> directly after an <ending> wrapper — place it INSIDE the wrapper (2026-08-30)

Discovered while validating partition pinning (page-splice spike 3): baking `<sb>` before every system-start measure reproduced the auto render's 118-system partition EXACTLY except at the one boundary whose preceding sibling was an `</ending>` — that pin was ignored (the following measure merged into the previous system, and castoff re-wrapped a bar later). Moving the `<sb>` inside the `<ending>` as its LAST CHILD makes smart honor it, restoring exact parity (max width delta 3 units over the whole document). Two related placement facts from the same session: an `<sb>` adjacent to a mid-piece `<scoreDef>` is suspect too (the one refill self-consistency failure, k=87, involves a pin moved next to a key-change scoreDef — ordering rule to be established during Phase C implementation), and an early "breaks:'encoded' is a dead end" verdict (118 systems exploding to 154) was WRONG — the probe had double-pinned page starts with BOTH `<sb>` and `<pb>` (118+36=154); with `<pb>` REPLACING `<sb>` at page starts, encoded reproduces the pinned partition and pagination exactly and, unlike smartSb0, never overrides a pin (smartSb0 can auto-wrap a pinned line it deems overfull — its fit threshold carries context state, the k87 class). Encoded's intra-line justification distribution differs from smartSb0 by up to ~516 units (~52 px) on the sonata — partition-identical, spacing slightly redistributed.

## Verovio breaks:'line' honors every <sb> VERBATIM and still auto-paginates — 'smart' does neither reliably, 'encoded' kills pagination (2026-08-30)

The three-way trade discovered while implementing Phase C-A line-break ownership, all probed on the sonata: `breaks:'smart'` (+breaksSmartSb:0) honors sbs but its castoff can RE-WRAP any pinned line it deems overfull by its own context-dependent internal fit metric — not reproducible from breaks:'none' natural widths (refilled lines at naturals-fill ~1.0–1.1 got wrapped wholesale, and historical smart lines span naturals-fills 0.71–1.43, so no FIT_MAX tuning can match it). `breaks:'encoded'` honors sb AND pb verbatim but paginates ONLY at encoded `<pb>` — no height-based page breaking at all (an sb-only 446-bar doc = one 121-system page; an overfull page stays overfull/clipped). **`breaks:'line'` is the missing middle: every `<sb>` verbatim (a deliberately merged 8-measure line renders unwrapped) + automatic height-true pagination, and with pins at Verovio's own partition it reproduces the smart render pixel-exactly (max measure x/width delta 0.0).** One gotcha: 'line' with ZERO `<sb>` in the data logs a Verovio warning and silently falls back to auto castoff — never send it a pin-less document (single-line docs should just derive).

## The model's renderDirty cannot be trusted as "what changed since the last render" — reset-then-narrow swallows 'all' under batch-mutate-then-render flows (2026-08-30)

renderDirty's lifecycle is per-MUTATION: invalidateMeterCache resets it to 'all', the mutation then narrows. So when several mutations land before one render (T2.2 burst coalescing, fixture setups, the composer-test runner's doc RESET via bare replaceDocument), the range read at render time describes only the LAST mutation — an earlier 'all' (or an earlier narrow range) is silently gone. The scroll splicer survives this because it never trusts the hint: its own per-measure sig maps + structural prefix/suffix diff are the truth, and dirty only bounds the serialization cost (with the HKL_INDEX_CHECK gate cross-checking). The page line-break owner initially consumed an accumulated union of renderDirty readings (renderer-side, fed per reRender()) — refuted by the runner's reset flow leaking a stale partition into a refill of a foreign document (pageViewMultiSystemCrisp visual regression). The fix (and the rule): **any incremental consumer keeps its own per-measure serialization baseline from its last commit and diffs against it; the hint is at most a cost optimization, never a correctness input.** Cost check before rejecting: a full per-measure XMLSerializer pass over the 446-bar sonata is ~13 ms.

## An adopted layout truth must be tied to the document state it was read from — capture the baseline in the same synchronous block as the render (2026-08-30)

The page-partition adoption reads system starts from the toolkit lazily (idle-chunked renderToSVG), but the doc can be edited before the idle work completes. Capturing the owner's sig baseline AT ARM TIME (the derive render's synchronous block) keeps "partition ↔ document state" consistent by construction: a later refill diffs the current doc against the state the partition actually describes, so edits made during the idle window are seen as dirty. Generalizes: whenever derived state is computed asynchronously from a snapshot-in-a-toolkit, snapshot the IDENTITY (sigs) synchronously with it.

## The virtualized page rebuild clamped #score's scroll on EVERY edit — zero-height placeholders + a forced layout mid-swap (2026-08-30, FIXED)

renderPage's virtualized path swapped #score.innerHTML to page 1 + EMPTY placeholder divs, then measured page 1 via getBoundingClientRect to size them — forcing layout while the scrollable extent was collapsed to ~one page. The browser clamps scrollTop at that moment and the clamp survives the re-sizing: probe-confirmed on the sonata, scrollTop 25392 → 2744 across a content-identical edit (2744 = one-page extent minus viewport, exactly). Every page-view edit therefore parked the scroll near page 1 and the afterRender scroll-into-view yanked it back — the "every edit shifts scroll then corrects" symptom Max reported after Phase C-A made edits semantically surgical (the jump had been hiding inside the full-re-render experience before). Fix: capture scrollTop/scrollLeft before the swap and restore them in the SAME synchronous block, after placeholders are sized and BEFORE mountVisiblePages (so the pages at the restored position are what mount). A genuinely shorter document re-clamps naturally. Fixture: pageEditPreservesScroll. Rule: any innerHTML rebuild of a scroll container must treat the scroll position as state to preserve explicitly — no intermediate layout may see the collapsed extent.

## Screenshot-capture truths from the composer-test visual rework (2026-08-30)

Three hard-won facts about CDP captures of content inside an inner scroll container (#score):
1. **A clip larger than the raster surface returns dark FILL inside the image.** `captureBeyondViewport: true` expands the DOCUMENT surface only — an `overflow: auto` container's hidden overflow is never rasterized, so clipping to a page card wider/taller than the window produced captures with dark right/bottom bands that look like the app cutting content off (it isn't the app — Max spotted it; two of us mis-attributed it first). To capture such content, temporarily resize the viewport via Emulation.setDeviceMetricsOverride so the content actually rasterizes, then restore.
2. **A fixed post-resize delay captures relayouts mid-flight** (the pagescale-140 baseline shot unscaled content in the corner of the grown page). Settle by POLLING: re-measure the geometry each frame until two consecutive frames agree, then shoot.
3. **Frame the clip to the fixture's intent, and never derive it from mutable overlay state.** The old clip united systems + visible cursor-overlay rects, silently coupling every baseline's framing to cursor state and run context (the phase3_section_header full-run-vs-isolation flake). Now: compact content-union by default (glyph-level fixtures), full page-card union as an explicit `visualFullPage: true` opt-in (page-level fixtures), and every capture reports meta (card dims, zoom, pageScale, scroll) into summary.json so the next framing discrepancy is a numbers lookup, not screenshot archaeology.

## Test-runner state that silently couples fixtures (2026-08-30)

Two more members of the "invariants that mutate state pollute later fixtures" family, both found chasing one visual flake:
1. **predictNextRenderHeavy's duration memory (`lastFullMs`)**: one heavy fixture flips every SUBSEQUENT fixture's renders from synchronous to deferred (badge + double-rAF), changing screenshot timing against recorded baselines and breaking read-right-after-reRender assertions. The runner reset now clears it per fixture.
2. **Lazy partition adoption is timing-dependent BY DESIGN** (idle-chunked; bail → derive → re-arm is legal and self-healing), so a fixture must ENGAGE ownership explicitly — render in a small settle loop until `ownershipActive()` — before asserting refill behavior. Asserting after a fixed number of renders means asserting on whichever intermediate the idle scheduler happened to produce; the pageLineBreaks fixtures flaked exactly this way (`lastDeriveReason` on the owner now names the bail cause in the failure detail).

## A windowed sub-render's last measure draws the END-OF-SCORE final barline — absorb it with a synthetic trailer line (2026-08-30)

Found by the Phase C-B sonata battery's context check, as a stubborn `dW=52, dRelX=0.0` on exactly the LAST measure of every window: the sub-document ends there, so Verovio draws the thick final barline (~5 px wider bbox) where the live line has a normal one — every other geometry byte matches. Mirror of the score-START artifacts the synthetic leader already absorbed (spike 2). Fix: when the window ends before the true document end, append a pinned synthetic mRest measure (`hkl-splice-trail`, its own `<sb>` line, discarded) — the trailer eats the final barline and the real last window line renders mid-score. Windows that DO reach the doc end must NOT add it (the live line legitimately carries the final barline; that's why doc-end edits spliced cleanly all along). Rule of thumb: a windowed render diverges at BOTH document edges — every artifact class needs its synthetic absorber, leader and trailer.

## Mid-piece section-level <scoreDef>s are invisible to per-measure signature diffs (2026-08-30)

A key/meter change lives as a `<section>`-level sibling BETWEEN measures, so a consumer that diffs per-measure serializations sees "nothing changed" when one is edited. Phase C-A got away with it (its refill still loadData'd the whole doc — output correct regardless); Phase C-B's system splice and the new no-op skip would have kept stale signature glyphs on screen. Guard shipped: `computeInteriorSig` (section-level non-measure/non-break elements serialized with measure-count positions) bails the refill to a derive render on any change; composer/footer credits joined `headSig` for the same reason (their page injections are mount-only). Rule: a sig-diff over measures covers ONLY measures — anything Verovio renders from outside them (head, interior scoreDefs, credits) needs its own explicit guard the moment a consumer stops re-rendering the whole document.

## A probe that edits the model directly cannot test undo — withHistory never runs, so Ctrl+Z silently no-ops (2026-08-30)

Chasing "does undo restore the layout exactly?", a sonata probe called `model.deleteAtCursor()` and then dispatched Ctrl+Z. Result looked alarming: the post-undo geometry equalled the post-EDIT geometry, and repeated cycles drifted monotonically (a measure's width grew 7194 → 7211 → 7380 units). The real story: only the INPUT layer wraps mutations in `withHistory`, so a direct model call pushes nothing on the undo stack — Ctrl+Z popped an unrelated entry (or nothing) and the probe quietly deleted one more chord per cycle (measure source 2834 → 2652 → 2397 bytes). The spot-splice doc already warned "drive through the input layer (keystrokes) to include withHistory"; it applies to any probe or fixture testing undo/redo, history labels, or edit reversibility. Two tells that should have redirected the diagnosis faster: `afterUndo` diffs byte-identical to `duringEdit` diffs (undo changed nothing at all), and the live DOM matching a fresh full render within 4 units (the RENDERER was right; the document was wrong). Rule: any reversibility test dispatches real keystrokes and asserts a content invariant (e.g. note count) after BOTH the edit and the undo, so a no-op undo fails loudly instead of proving a phantom bug.

## Verovio spaces the SAME document differently per breaks algorithm — and page-based getMEI hands you the castoff layout 18× cheaper than rendering it (2026-08-30)

Two findings from Max's challenge "I have not seen any evidence that smartSb0 and encoded justification actually differ. And if they do, they shouldn't."

**They do, and it is the mode alone.** On byte-identical data (same `<sb>` pins, only the `breaks` option changed), `line` vs `encoded` moved 409 of 446 measures — median 26 units (~2.6 px), p90 121, max 515 (~52 px) — with identical pagination and identical measures-per-system. Adding the `<pb>` elements on top changed **0** measures (max 1 unit), so the page-break elements are inert and the break ALGORITHM is the whole cause. The differences are not concentrated at section breaks either: 85 of 118 lines have no encoded break or mid-piece scoreDef anywhere near them and still average 77 units of drift (worst 340). `line` ≡ `smartSb0` exactly, which is why C-A's parity claim held while this went unnoticed. Consequence for any splice architecture: **windows must render in the same breaks mode as the live page**, or spliced systems carry the other mode's spacing.

**`getMEI({scoreBased:false})` returns PAGE-BASED MEI** — `<page>`/`<system>` wrappers encoding exactly what castoff decided (37 pages / 118 systems on the sonata) in ~47 ms, vs ~1830 ms to learn the same thing by rendering every page to SVG and reading `g.system > g.measure`. The partition it yields is byte-identical to the SVG walk's. Two gotchas: `getMEI({pageNo: N, scoreBased: false})` returns an EMPTY string (ask for the whole document, not a page), and Verovio echoes our `hkl:` metadata elements without their `xmlns:hkl` declaration, so its output is not well-formed XML until you re-declare the prefix on the root. Also note the default `getMEI()` is score-based and does NOT contain the castoff breaks — it is essentially the input back.

Together these turn "make every render use one break algorithm" from unaffordable into routine: cast off once (loadData only, never painted), read the partition via page-based getMEI, then paint the pinned `encoded` render.

## A derived-state cache invalidated by call discipline is unsound here — use a MutationObserver, whose takeRecords() is synchronous (2026-08-30)

Phase D's biggest win was caching the two whole-document enumerations every keystroke rebuilds (`flatChildren`, `allMeasures`) plus the refill's per-measure signature baseline. The obvious invalidation point — `invalidateMeterCache()`, which the model already documents as "reached by every structural/content/meter mutation" and already uses for `voiceIndexCache` — is **not sufficient**, and the `HKL_INDEX_CHECK` assert caught it on the first suite run (286 failures, all one message): `insertWithSplit` reads `flatChildren` in the MIDDLE of its mutation, between its own DOM writes and its closing `normalizePlaceholdersAll()`. Any "invalidate when the operation finishes" scheme serves that read a stale list. The design doc had literally warned about this ("`flatChildren` is deliberately NOT cached — mutation code reads it mid-operation"); the warning was right and auditing call sites would not have made it safe.

What works: observe the live document with a `MutationObserver` and invalidate on actual DOM change. The load-bearing property is that **`takeRecords()` drains SYNCHRONOUSLY** — it returns everything queued right now, so a read taken mid-mutation sees the writes that preceded it in the same task. Two details are required for correctness: (1) the observer's own callback drains the queue on its microtask, so a `fired` flag must record that path too — check `takeRecords().length || fired`; (2) undo/redo/load replace the document object entirely, so compare document identity and re-arm (treating the swap as "everything changed"). With those, invalidation is exact by construction rather than by audit, and it is strictly safer than the discipline it replaces.

The same mechanism gives an incremental *per-measure* baseline: fold each record's target up to its containing `<measure>` and dirty that measure; a record whose target is ABOVE measure level (a `<section>` childList insert/remove, a mid-piece `<scoreDef>`, the head) means the measure SET or the shared context moved, so nothing may be assumed clean. Keeping element identity alongside each cached signature (`sigEl`) closes the last hole — a measure that is still the same object AND was never mutated cannot serialize differently. Result on the sonata: `XMLSerializer` 495 → 54 calls per keystroke, `querySelectorAll` 31 969 → ~3 400, `cursor.update` 62.6 → 1.8 ms.

Keep the verifications permanent, not one-shot: the model re-enumerates and compares on the first cache hit at each document version under `HKL_INDEX_CHECK` (originally on EVERY hit — see the 2026-09-01 entry on why that went quadratic on large edits and why once-per-version is the same guarantee), and the owner re-serializes the whole document and compares every string. The 339-fixture suite then stands as a gate on the mechanism itself, and it costs nothing in production. (Measured: the suite's wall time was unchanged at ~190 s with the asserts in.)

## A probe that RECORDS a result without ASSERTING it hides a broken test indefinitely (2026-08-31)

The Phase C-B sonata battery recorded `editOk` per edit and never checked it, so two of its eight edits had not been applying **for months**: `reinsert-mid-line` deleted a 16th (freeing 4 ticks) then inserted a QUARTER, and `insert-rest-ripple` deleted one 8th (freeing 8) then inserted an 8th rest — which alone refilled the measure — followed by an 8th chord. Both inserts were correctly refused by the planner, so those entries were really only testing their delete. The battery still reported `allReferenceOk: true` and "7 of 8 spliced", which looked like a pass.

Two rules follow. **(1) Any diagnostic a probe bothers to compute should be asserted or deleted** — an unasserted field is worse than no field, because it reads as coverage. The battery now aggregates `allEditsApplied` / `editsNotApplied`. **(2) When a probe's edit doesn't apply, check the documented rule before theorising.** The insertion contract is settled and written down (architecture/composer.md, planner invariants): *"Measures never exceed length. Content landing past the cursor's measure requires that target layer EMPTY, else reject."* Bounded overflow crosses ONE barline and only into an empty layer. Measuring the next measure (`cb-editok.js`) showed bar 101 and bar 151 both completely full, so refusal was exactly specified — no model bug, no ambiguity. Do not call settled, documented behaviour a "design question": look it up, then measure the case against it.

## Verovio's page-view zoom is NOT pure magnification — zoom 75 breaks differently from 50 and 100 (2026-08-31)

While caching the page-view line partition per (zoom, pageScale), a round-trip probe showed zoom 50 and zoom 100 producing an IDENTICAL 118-line partition via two INDEPENDENT castoffs. The tempting inference — page rectangle and content scale by the same factor, so zoom is pure magnification and can leave the cache key, making even the first zoom change skip the castoff — is WRONG. Forcing a real castoff at every preset: **zoom 50 → 118 lines, zoom 75 → 134 lines, zoom 100 → 118 lines.** The crisp presets pick scale values that land staff lines on the device-pixel grid, so the content-to-page ratio is not uniform across levels and 50/100 agreeing is a coincidence of that quantisation. Any per-zoom cache must key on zoom. Generalises: two samples agreeing is not invariance — sweep the whole discrete domain before removing a key, especially when the "obvious" model of the mechanism predicts the agreement.

## `breaks:'line'` honors OUR `<pb>` pins but did not honor a lone user `<pb>` over sb-baked data (2026-08-31)

`cb-linepb.js` established that `breaks:'line'` honors `<pb>` — pagination followed the pins exactly. That finding holds for a FULLY PINNED document (our `<sb>` at every line start, our `<pb>` at every page start). It does not generalise: casting off the sonata with 117 baked `<sb>` plus ONE user `<pb>` under `'line'` produced 37 height-derived pages with the break measure sitting **mid-page-4** (`breakIsAPageStart: false`), while the same data painted under `'encoded'` broke there correctly (38 pages). So `'line'` paginates by height and treats a sparse user `<pb>` as something less than a hard boundary in that configuration.

Practical consequence for page-view ownership: a height-derived castoff cannot be trusted to report user page breaks as page starts — they must be UNIONED into our page-start list explicitly, which requires our own page-fit loop (walk lines accumulating height, start a page at a user break or at overflow). Until that exists, a document with a user `<pb>` renders correctly (because the painted `'encoded'` render honors the break from the data) but its pagination is not owned: our page list is one short, `paginationHeld` fails near the break, and edits there fall back to a full render. Verified stable — no warning loop, no clipping — but not owned.

The general rule: a "does Verovio honor X?" finding is only valid for the exact break-mode AND data configuration it was measured in. Re-measure before relying on it in a different one.

## Verovio's `scale` is layout-neutral; `unit` is not — and no page size compensates for a unit change (2026-08-31)

Two facts, both measured on the sonata, that together settle how zoom interacts with page-view line breaking.

**`scale` has no layout effect.** Zoom 50 and zoom 100 differ only in `scale` (50 vs 100) — identical `unit: 9`, identical page rectangle — and produce byte-identical 118-line partitions. So magnification is free: any number of zoom levels can share a layout as long as their other options match.

**`unit` does, and it cannot be compensated by page size.** HKL's crisp presets are not uniform in `unit` (50 → 9, 75 → **10**, 100 → 9), and `scalePageGeom` scales the page by `pageScale` only. So zoom 75 renders ~11 % larger music against the same paper and re-breaks the score: 118 → 134 lines, against the documented intent that "zoom is pure magnification and does not change music-per-page" (decisions.md, "Score size relative to page"). The obvious fix — grow the paper by `unit / 9` so the music:paper ratio is restored — is a **DEAD END**: it matched `contentWidth / unit` to five digits (208.79 vs 208.78) and still gave 113 lines where 118 was wanted. Verovio's horizontal spacing contains terms that do not scale with `unit`, so there is no paper size that reproduces another unit's layout, and searching for the factor empirically is just reverse-engineering the spacing model.

**"Just use one `unit` everywhere" is the RIGHT answer — at the right unit.** My first attempt (`unit: 9` at a fractional `scale: 77.78`) was correctly refuted by the `render-presets.ts` header: staff-space (`unit × scale / 50` device px) must be an integer, and a fractional scale also breaks the whole-device-px stroke rule and re-opens Verovio's root-`<svg>` ceil drift. But the header's "only scales that are multiples of 50 work" is specific to unit 9. The general rule is **`gcd(unit, 50)`**: a scale must be a multiple of `50/gcd(unit,50)`. Unit 9 (gcd 1) → multiples of 50, so nothing between 50 % and 100 %. **Unit 8 (gcd 2) → multiples of 25, so 50/75/100 are all crisp at ONE unit** (staff-space 8/12/16 px, strokes 1.0/0.975/2.0 px). Constant unit ⇒ zoom is layout-neutral by construction, and the page-view partition cache collapses to a single entry for every zoom.

Two process lessons on top of the technical one. **Unit 9 was never chosen** — it is Verovio's default, inherited; the 50/75/100 ladder predated the presets; unit 10 arrived in a grab-bag commit solely to rescue 75 %. And decisions.md asserted the opposite of the defect ("zoom is pure magnification and does not change music-per-page"), so nobody weighed the cost. **When a co-tuned constant looks wrong, search for the derivation first (it may refute you) — but check whether its stated constraint is general or specific to the value it was derived at.** Mine was specific, and reading it as general cost a dead end.

Rules: to make a layout invariant across a UI control, make the layout INPUTS identical and let only `scale` vary — never try to cancel one layout input with another. Key a layout cache on the layout inputs (`unit`), never on the UI label (`zoom`) — two labels sharing a unit can share the entry, and one label can silently change the layout. And before "fixing" a co-tuned constant, find the derivation: this one cost two dead ends, the second of which was already written down.

## A page can only begin where a LINE begins — so a user `<pb>` must be merged into the line partition, and no single Verovio mode paginates by height while honoring it (2026-08-31)

The user-page-break defects (a break before a page's last line leaving a page with just that line; a mid-system break not reflowing measures) were one root cause with two faces, and the fix needed two facts about Verovio's break modes:

**No mode does both jobs.** `breaks:'line'` paginates by height but treats `<pb>` as a SYSTEM break — measured on the sonata, a document with one Ctrl+B returns the *same* page count as with no break at all and the break measure is not a page start. `breaks:'encoded'` honors `<pb>` as a page break but never paginates by height (that is the old 37 → 2 giant pages). So taking `'line'`'s page starts and painting `'encoded'` layered the break ON TOP of pins computed as if it did not exist: an extra boundary with nothing after it re-packed. The fix is to segment the castoff at user breaks and paginate each segment independently — Verovio stays the page-fit engine, we only choose where to cut, and no height model is needed.

**And the break measure must be merged into the LINE partition first.** A page begins with a new system, so the break measure has to start one — but the whole-document castoff runs under smartSb0, which IGNORES `<pb>`, so that measure is generally mid-line and absent from the partition. Omitting the merge is self-inconsistent in a way that is easy to miss: the segment document *begins* at that measure, so Verovio necessarily starts a line there, and a partition-equality check between "what I pinned" and "what came back" refuses. Keeping that check is what turned a silent wrong-pagination into a clean bail (it fell through to the old path rather than painting a layout the page list did not describe). The same merge is what makes a mid-system break reflow its measures: the measures before it finish the now-shorter previous line.

Two smaller traps in the same change: `injectPins` deliberately emits no pin for the FIRST line, so a single-line segment hands `'line'` data with no encoded break — Verovio warns ("Requesting layout with line breaks but nothing provided in the data") and silently falls back to castoff; short-circuit such a segment instead (one line cannot overflow a page). And the composer suite treats any console warning as a failure, which is exactly how that surfaced — two unrelated-looking fixtures failing on an identical warning string is the tell that a shared render path started warning.

## Verovio's system placement does not match the rendered bbox — so read a position from a page you reproduced, never model it (2026-08-31)

The Phase C-B v1 vertical gate refused to splice whenever a system would move,
and B1's job was to compute the movement instead. For systems stacked WITHIN a
page the window already predicts it exactly (probe `cb-window.js`: delta 0.0).
The one that resisted was a page's FIRST system, modelled as *"a page's first
system anchors its content top at the margin, so its staff lands at
margin + hanging extent"*. Measured against real full renders, that model was
exact on some pages and **~85 units (≈8 px) wrong on others**.

**Two independent causes, both invisible from the model side.**

1. **`getBBox` is not the overflow Verovio counted.** Reading the topmost
   descendant of every page-first system on the sonata: pages whose bbox top
   sat at the common anchor (~419) were all predicted correctly, and the
   outliers (335, 340, 347, 577) were all `<text>` — `g.dir`, `g.tempo`, and
   HKL's own HEJI `g.accid`. Verovio places systems from its INTERNAL metrics;
   for text those disagree with what the browser actually paints, so a bbox
   hang over-counts by however far the text overflows. There is no "counted"
   element set worth enumerating, and enumerating one would be a model that
   silently mis-positions systems when it drifts.
2. **`header: 'auto'` reserves a band on every page.** The live page options
   use it; the splice window overrode it to `'none'` (inherited from the
   tall-page trick that `breaks:'line'` needed). That band is precisely what
   anchors a page's first system — suppressing it put every window-page-first
   system **~419 units too high, uniformly**. A constant offset is the easiest
   error to miss: it satisfies every *relative* check.

**The fix is structural, not arithmetical.** The window carries `<pb>` pins at
the live page starts, so it paginates exactly where the mounted document does
and a page-first system is page-first in the window too; its position is then
READ (both coordinate systems are page-margin relative), not derived. With the
window also using the live page options verbatim — `'encoded'` paginates only
at encoded breaks, so the tall page was never needed once pagination was owned
— the worst prediction error over 19 samples fell from **425 units to 8**.

**Guard against the constant.** A dy-cascade that shifts a whole page by a
constant passes every consecutive-spacing assertion. Both the inline
`HKL_INDEX_CHECK` reference gate and `cb-splice-battery.js` now compare
**absolute** staff tops against the reference render, not just spacings
(sonata: ≤6 units over 30 pages, pure snap noise).

**And apply a measured plan all-or-nothing.** The plan is accurate to ~±8
units, so "applying" a 3-unit movement adds error rather than removing it, and
re-snaps every system on the page for a sub-pixel edit — it showed up
immediately as a visual-baseline diff on an edit that used to move nothing.
A splice now either pins systems to their live positions exactly (v1 behaviour,
when nothing moves by more than EPS) or applies the whole plan.

## A mount-time DOM injection is invisible to every layout model that runs later — and exempting it from a gate is how it goes wrong silently (2026-08-31)

Section titles are injected by `injectSectionHeaders` (main.ts) when a page
MOUNTS: it translates the header's system and every later system on that page
down by `SECTION_HEADER_RESERVE`, then appends the title `<text>` to the
page-margin at an **absolute** y derived from that system's bbox. Verovio knows
nothing about any of it. Once the B1 dy-cascade started MOVING systems after
the mount, that produced two defects at once — and only one of them was
visible:

1. **The title stayed behind.** It is a page-margin child, not a child of the
   system it labels, so nothing moved it. Measured: the header's system moved
   149 px down and the title moved 0, clearance 40.7 → 189.7 px. In the other
   direction (an edit that SHRINKS a line above the header) the music slides up
   over the words — the symptom Max reported.
2. **The cascade distance was wrong by the whole reserve.** The plan chains
   live staff tops, and the live spacing across a header boundary contains the
   900-unit displacement that the splice window does not. So `dyFollow` came out
   900 units short (1536.9 where 2436.9 was right) — a mis-placed system, not
   just a mis-placed word.

**Both are the same root cause and have one fix**: reason in the coordinate
space the layout engine actually produced. The plan now subtracts each system's
accumulated reserve before chaining and adds it back afterwards, and the
cascade moves a title whenever it moves the system that title labels.

**Read the injected value; do not duplicate the constant.** The injector records
what it applied on the title element (`data-reserve`), and the splicer reads it
back. A title with no readable reserve refuses the splice rather than guessing —
guessing is what produced the overlap.

**The gate exemption is the real lesson.** Both the inline `HKL_INDEX_CHECK`
reference gate and the sonata battery *skipped the vertical checks on
section-header pages*, on the reasonable-sounding grounds that the reserve is a
main.ts injection the raw reference render lacks. That exemption is exactly why
a 900-unit misplacement and a stranded title passed every gate. Subtracting a
known offset is a comparison; skipping the comparison is a blind spot. Both
gates now verify header pages like any other (sonata: max absolute staff-top
delta 6 units over all 30 pages, 3 of them header pages), and the reference gate
additionally asserts each title still sits inside its own reserve band.

Rule: when a post-render pass moves rendered geometry, either fold it into the
render or make it *measurable* from the DOM — and never let a verification gate
skip the pages where it applies.

## A placeholder must be sized to the box the page will BECOME, not the box it has now (2026-08-31)

Every deletion appeared to nudge the score down a few pixels. It was not the
splice: page-view virtualization renders page 1, measures it, and gives every
other page a placeholder of those dimensions; `mountPage` then drops the
explicit dims and lets the page size to its own content. Two mismatches made
that swap change the document height:

1. it measured the **inner SVG** (2794 px) while a mounted page is the
   **`.score-page` div** (2796 px), and
2. it measured **before `finishPageMount`**, so page 1's crisp pinning and the
   main.ts injections had not run yet.

So every page grew exactly 2 px the moment it mounted — 56 px across the
sonata. A splice never touches the page grid, but a FULL render rebuilds it,
which is why the drift tracked fallbacks: 34 of 42 full renders moved the
document, versus 3 of 65 splices. Measuring page 1's div after
`finishPageMount` takes the per-page error to 0.

Two general rules. **A predicted size must be measured on the same element, in
the same state, as the thing it predicts** — an inner box is not the outer box,
and "before post-processing" is not "after". And **when a symptom says "a few
pixels", suspect a whole-number layout discrepancy repeated per element**, not
an accumulation of rounding: the tell here was that the drift came in exact
multiples of 2.

## A gate that verifies the CONTENTS of a box never notices the box (2026-08-31)

The splice's reference comparisons — the inline `HKL_INDEX_CHECK` gate and
`cb-splice-battery.js` — check per-measure x/width, consecutive-system spacing
and absolute staff tops, all **page-margin relative**. A page whose own box
changes leaves every one of those deltas at 0.0. The 2 px drift was therefore
invisible to every gate the project had, on every run, for as long as it
existed. Same shape as the section-header exemption a day earlier: verifying
inside a frame says nothing about the frame. `cb-sweep.js` now records
`scrollTop`, container `scrollHeight`, and each page's `offsetHeight` /
`viewBox` around every edit.

## A test that pre-mounts everything cannot see a lazy-mount bug — and reports worst-case latency (2026-08-31)

`cb-splice-battery.js` calls `mountAll()` before each of its 8 edits. That is
one line, and it made two whole classes of behaviour unobservable: every
`changed line not mounted` / `context line below not mounted` refusal (B5), and
any measurement of what an edit costs with a realistic 2–6 pages mounted rather
than all 30. Driving the real `IntersectionObserver` instead (scroll the
container, wait for the placeholder to resolve — never call `mountPage`) moved
the measured hit rate from "7 of 8" to **56.5% of 116 lines**, and splice
latency from ~400 ms to a 245 ms median.

Corollary worth generalising: **a hand-picked sample reports a pass/fail, never
a rate.** "7/8 spliced" and "56.5% of lines splice" describe the same build.
When coverage is the property under test, sweep the document and emit a
histogram of the failure REASONS — that histogram is what turns "many systems
refuse" into a ranked work list.

## A fixed point over spanners is a chain walk; one containment pass is the rule (2026-08-31)

`expandForSpanners` grows a measure range until every spanner overlapping it is
contained, re-scanning after each growth — a transitive closure over the
interval graph of spanners. The page splicer then wrapped that in a second loop
that rounded out to line boundaries and re-expanded, feeding newly-added
CONTEXT lines' spanners back in. Result on the sonata: `window too many lines`
was the single biggest splice refusal, firing even on edits that replaced ONE
line.

Nothing pathological was in the document. It holds **926 spanners, 922 of them
slurs, none longer than 3 measures, and not one crossing more than a single
line boundary** — but ordinary legato phrasing puts each slur's end on the
downbeat where the next begins, so the closure hands off from slur to slur.
One seed walked **17 slurs deep, 24 measures, 6 lines**, entirely through lines
nobody was re-rendering.

The correct rule (Max): **a spanner with one end inside the replaced set needs
the window to cover its other end.** That is one containment pass, not a fixed
point — a spanner lying wholly outside the replaced set cannot change how those
lines draw, and one dangling out of a *context* line is harmless because
context lines are only measured for per-measure x/width. Measured over all 446
measures: replaced set max 5 → 2 lines, window max 14 → 6, and the 52 seeds
that blew `MAX_WINDOW_LINES` became 0. Both caps stopped binding.

The general trap: **a transitive closure is the right tool for "must be whole",
and the wrong tool for "must be visible".** Ask what the range is FOR at each
step; here the replaced set and the window wanted different closures, and
sharing one iteration conflated them. Truncating a spanner at the window edge
(anchoring it to the synthetic leader/trailer) remains the answer for a
genuinely document-long spanner — the sonata has none, so it stays unbuilt.

## Mount-on-demand without eviction is an accumulator, and it leaks into edit latency (2026-08-31)

Page-view virtualization mounted pages lazily and never un-mounted them:
`mountPage` only added to `pageVirt.mounted`, and the only thing that removed
pages was a full render rebuilding the grid. So the mounted set was monotonic
between full renders and converged on "every page you have visited" — 2 → 9
across a sweep, 30 under the battery's `mountAll`. Because every `getBBox` in a
splice flushes layout across all mounted pages (the A6 finding: ~400 ms per
splice at 30 pages vs ~245 ms at 2–6, +260 % from 1 page to 37), the accumulator
was a slow leak in edit latency that got worse the longer you worked.

The perverse part: **improving the splice hit rate made it worse**, because full
renders were the only thing collecting the garbage. A cache with no eviction
policy plus a change that reduces cache flushes equals unbounded growth.

Three things worth carrying forward:

- **Give a lazily-populated set an eviction rule at the same time you give it a
  population rule.** The mount band and the evict band must differ (here: one
  viewport vs two) or the boundary churns, and a re-mount costs as much as the
  original mount (~138 ms).
- **Match the eviction band to whatever else mounts.** The IntersectionObserver
  arms at `rootMargin: 100%`; evicting inside that band would have the observer
  and the policy fighting each other every scroll.
- **Un-mounting is only safe if a placeholder is exactly the size of the page it
  replaces.** Ours was 2 px short until the same day, so eviction would have
  shifted the document under the reader — the identical defect that pass had
  just fixed. A reversible representation has to be *dimensionally* reversible.

And the estimate lesson: the B5 note said a mount costs "~50 ms"; measured, it
is ~138 ms — `mountPage` is a `renderToSVG` *plus* the entire per-page post pass
(crisp pinning, barline and right-edge snapping, notehead reordering, HEJI
injection, theme tagging, header/footer, section headers, volta styling,
`snapSystems`). An estimate written next to an unimplemented item is a guess;
re-measure it the moment it becomes load-bearing.

## A sub-document cannot know about the context that generated its edges (2026-08-31)

The splice's last remaining large refusal class was a context line whose measure
widths differed from live by 43–347 units, always with `dRelX=0.0` — same
positions, different width. The cause: Verovio draws an **end-of-line courtesy
signature** because of the line that FOLLOWS, and a windowed sub-document does
not contain that line, so it renders the boundary without a courtesy the live
page has. The window must include the line that *generates* the artifact, not
merely the line the artifact appears on.

This is the same shape as two artifacts the window already handled — the
score-start treatment (absorbed by a synthetic leader) and the end-of-score
final barline (absorbed by a synthetic trailer). The general rule: **a windowed
re-render must contain every element whose PRESENCE changes how the window's own
edges draw, which is not the same set as the elements that appear inside it.**

Two process notes. The design doc had recorded this item as "a boundary MOVING
next to a clef/key change, fixed by re-splicing k−1" — but every measured
refusal had `refillLines: 0`, i.e. no boundary moved at all. A plausible
mechanism written down before it was measured sat unchallenged for a day and
pointed at the wrong fix. And correlating before implementing (`cb-courtesy.js`:
does a signature change begin the line just beyond the window?) explained 9 of
11 refusals up front, which is what made the fix a three-line change instead of
a search.

## A boundary-condition fixture must be run against the UNFIXED build (2026-08-31)

The first version of the B3 fixture put a key change at a line start and edited
the line directly before it. It passed — on both code states. The reason is
exactly the subtlety the fix is about: editing the line *directly* before the
change makes the generating line the context line, which is already inside the
window, so the divergence never arises. Moving the edit one line further back
posed the real case, and the fixture then failed pre-fix with the expected
`dW=101.0`.

A fixture written from a description of a bug tests the description. Stash the
fix and run it: if it still passes, it is not a regression guard, whatever its
name says.

## An intervention that reproduces the previous total to the unit has not done what it claims (2026-09-01)

Retargeting the coverage sweep was meant to convert 8 of 115 lines from
"performed a cursor move" into real deletions. It reported **exactly** the same
102/115 splices as before. Max's reaction — *"it's literally the same number,
which shows literally none of the newly real edits are being accepted. This is
suspicious"* — was the right instinct, and my first explanation of it ("the 8 all
refused") was wrong too.

The cause: the selector stopped at each voice's first in-line note. That note is
the earliest in DOCUMENT order, which was the WORST rank in the mid-line-first
ordering it was supposed to honour, and it falls in the line's first measure in
the common case. So the mid-line preference was dead code and **all 115** lines
were silently retargeted onto their first measure, not the 8 that needed it. Two
opposing effects — 8 lines gaining real edits, ~107 lines moving to a harder
target — cancelled in the total. Fixing it gave 109/115.

Three transferable points:

- **A suspiciously stable aggregate is evidence, not reassurance.** Changing a
  sample and reproducing the statistic exactly means either nothing happened or
  two effects cancelled; both need explaining before the number is quoted.
- **Report what changed per item, not just the summary.** A per-line diff of
  target measure between the two runs would have shown the retarget touching
  every row in one glance. The summary could not.
- **`break` on "the first match" is only correct when document order IS the
  preference order.** Here the preference was explicitly the reverse, so the
  early exit inverted it while looking like an optimisation — and the comment
  next to it asserted the opposite of what it did.

A fourth point, learned by getting it wrong twice in a row. I explained the
88.7 % vs 94.8 % gap as "first-measure edits move boundaries" — checked
afterwards, `refillLines > 0` in **zero** of 115 rows in either run, so no
boundary moved anywhere and the mechanism I named does not exist. What the data
does support, measured directly per position (`cb-seedreach.js`): a line's FIRST
measure is an endpoint of a boundary-crossing slur or tie **47.4 %** of the time
against **0.9 %** for a middle measure (last measures: 49.1 % forward), so it
replaces 1.47 systems on average against 1.01. The splice replaces whole
systems, but HOW MANY comes from a MEASURE-level closure rounded to lines — the
replaced set is position-sensitive even though the window, seeded from the
replaced LINES, is not. And the hit-rate
gap itself is weak evidence — only 9 lines flip, one in the opposite direction,
and they cluster onto four or five shared causes (three of them the same
divergent context line). **A mechanism that explains the direction of an effect
is not thereby the cause of it, and a percentage-point gap computed from a
handful of clustered flips should be quoted as counts, not rates.**

**Epilogue (2026-09-01): the effect itself was not real.** Editing all 446
measures gives first 92.7 %, middle 91.5 %, last 92.6 % — position does not
change the outcome rate at all. The closure-reach difference IS real (47.4 % vs
0.9 %), so edge edits genuinely replace more systems (1.47 vs 1.01); that extra
system is simply almost always fine. So I proposed two mechanisms for a
difference that 115 clustered samples had manufactured, and the user's first
instinct — "more likely random variance based on the targets themselves" — was
correct before either mechanism was examined. **When someone challenges an
effect rather than its explanation, test the effect first; explaining a
difference presumes it exists.**

## A gate whose throw is caught is not a gate — `doReRender` swallowed every render error into the status bar (2026-09-01)

The page splicer's acceptance gate (`verifyAgainstReference`, under
`HKL_INDEX_CHECK`) full-renders the same pinned MEI offscreen and **throws** on
any divergence. It works: fed a real bug — a page-first system placed 650 units
too high — it produced
`[page-splice] page 1 system 0: staff top diverged from reference (1373.0 vs 730.0)`.

Nothing ever saw it. `doReRender` (main.ts) wrapped the whole render path in
`catch (e) { setStatus('render error: ' + e.message, 'error') }`, and
`setStatus` only writes `textContent` on a `<span>`. No console, so devtools
showed nothing and the composer-test suite — which fails on console errors —
could not see it either. The splice was recorded as `spliced`, the fixture's
seven non-visual invariants passed, and only the pixel comparison objected. Two
compounding factors: `pnpm test:composer` is `run.mjs full` with no
`HKL_INDEX_CHECK`, so the gate was usually off entirely; and when it WAS on, it
was silent. Every "verified against a full reference render" claim in
composer-page-splice-design.md rested on this.

Fixed by always `console.error`-ing in that catch and RE-THROWING under
`__HKL_INDEX_CHECK`, verified by reintroducing the bug and watching the suite
fail with the divergence text. The three user-action catches (save / MusicXML /
PDF export) keep their status messages — that is the right UX there — but they
now log too.

- **An error path that terminates in a UI string is a silence.** A status bar is
  for the user; it is not an error channel, and nothing automated reads it.
- **A gate is not verified by the fact that it exists.** Make it fail on purpose
  once. "The gate passed" and "the gate did not run" are indistinguishable from
  a green result — I asserted the former about a run where the latter was true.
- **An opt-in gate that the standard command does not set is off.** Check what
  the script actually runs before citing it.

## Two window recipes, and the large-document battery only exercises one (2026-09-01)

The page splicer builds its offscreen window differently depending on whether
the line-break owner has taken pagination: `paginationOwned()` uses the live
page options verbatim, and the unowned path adds a tall page so `'line'` cannot
paginate. That second branch also carried `header: 'none'` — which removed
Verovio's page-1 `pgHead` band (600 units on a titled document) from the window.
`verticalPlan` reads a page-FIRST system's position **absolutely** from the
window, so line 0 landed 650 units high and slid the whole page up underneath
its own title.

Two things kept it hidden. Line 0 is the ONLY line that can reach the page-first
branch in the unowned path — a mid-score window's first system is the synthetic
leader, so no real line is window-page-first — and line 0 was excluded by a
separate guard until the day this was found. And the sonata, which every
large-scale probe uses, has pagination OWNED, so `cb-splice-battery.js` and
`cb-sweep.js` cannot execute the unowned branch at all: both reported identical
numbers before and after the fix. The only documents that exercise it are the
small synthetic ones in composer-test.

This is the same lesson as "Verovio's system placement does not match the
rendered bbox" (2026-08-31), one path over: the owned branch had already learned
that suppressing the header hides a ~419-unit anchor band. A fix applied to one
of two parallel recipes is half a fix.

- **When a code path forks on a mode, ask which mode your battery is in.** A
  probe suite on one large document may never enter the other branch.
- **An absolute anchor read from a sub-render is only valid if the sub-render
  reproduces everything above it.** Any option that removes vertical furniture
  from a window invalidates every absolute reading taken from it.

## The first mismatch a comparator names is where drift became VISIBLE, not where it started (2026-09-01)

`profilesMatch` compares a window context line to its live counterpart measure
by measure and returns on the first x/width delta past `EPS`. Six divergent
lines on the sonata sat in the START HERE list for two sessions described by
that string alone — `m-5o3: dRelX=0.0 dW=347` — and every hypothesis built on it
was about the FIRST measure of the line. Wrong measure. A line is justified, so
whatever changes at its END (a courtesy signature that is or is not drawn)
redistributes across every measure, and the first measure is simply the first
place the redistribution exceeds 25 units. With the whole per-measure diff in
hand (`lastContextDiff`, `cb-ctxdiverge.js`) the last measure read
`dW=-956, census {keySig:[0,3], keyAccid:[0,9], meterSig:[0,3], clef:[0,1]}` —
the live page draws a courtesy key+meter+clef the window lacks — and the cause
took minutes.

The same census answered the positional cases too: `clefs [["E05C","E062",
"E062"],["E05C","E050","E062"]]` says "the window drew staff 2 in an F clef
where live has a G clef" without a screenshot.

- **A gate that reports one number is a detector, not a diagnostic.** On the
  refusal path — which is never hot — record the full comparison and a census of
  what was drawn. The cost is nothing; the alternative is guessing from a
  summary that points at the wrong place by construction.
- **Justified lines smear an edge defect across every measure.** Any width-only
  divergence with `dRelX=0.0` at the FIRST measure should be read as "something
  at either END of the line", never as "something about the first measure".

## A render-time pass that moves content across measures is a dependency the sig-diff cannot see (2026-09-01)

`relocateInitialClefs` draws a measure-initial clef at the END of the PREVIOUS
measure (the change glyph before the barline). So the RENDER of measure i−1
depends on the CONTENT of measure i — and the page splicer's changed run comes
from a per-measure content signature. Deleting the chord ahead of a mid-measure
clef in the sonata's last measure made the clef measure-initial; a full render
moved it onto the line above and re-justified that line by up to 329 units; the
sig-diff said only the last measure changed; the context check refused
("unchanged context that changed"), correctly, at the cost of a full render.

Two separate holes fell out of the same pass. The range serializer DROPS a
range-initial leading clef (its glyph belongs to the out-of-range predecessor)
but `runningScoreDefContext` stopped BEFORE the target measure, so the head kept
the OLD clef and the whole sub-render — context lines and the replaced line
alike — drew staff 2 in the wrong clef. Eleven units of ledger-line drift on a
context line is all that stopped one such window from being spliced in.

- **Every render-time pass that reads a neighbour is a hidden edge in the
  dependency graph.** When a splice is scoped by "which measures changed",
  enumerate the passes that make measure i's picture depend on measure i±1
  (relocated clefs; end-of-line courtesies; ties to the next measure) and
  widen the run for each.
- **A sub-document that drops an element must reproduce its EFFECT.** Dropping
  the clef without folding it into the head is the same bug as `header:'none'`
  hiding the anchor band: the window no longer reproduces the state the full
  render has at that point.
- **The context check is load-bearing for correctness, not only for fidelity.**
  It caught a wrong-clef window by a margin that could easily have been inside
  EPS. When a refusal looks like "small drift, tighten nothing", look for what
  the drift is a SYMPTOM of before touching the tolerance.

## Document order at a section boundary is `scoreDef > sb > measure` — a "previous sibling" check walks past it (2026-09-01)

`beginsSignatureChange` asked whether the measure beyond the window begins a
signature change by testing `previousElementSibling.localName === 'scoreDef'`.
Both the MusicXML importer and `setSectionHeaderAt` put the section break
BETWEEN the scoreDef and the measure, so at every movement boundary the check
saw an `<sb>` and said no — and it also scanned only the first staff, so a
piano right hand changing clef at a line start was invisible. Two of the six
remaining refusal signatures (dW 347 and 604) and part of a third (dW 49).

- **Walk siblings until a measure-bearing element, not one step.** Break
  elements (`sb`, `pb`) are inert for content but real for adjacency.
- **"The first staff" is never a proxy for "any staff"** in a check about what
  Verovio draws — it draws per staff.

## Prevailing state is a document-wide dependency; a per-measure signature diff cannot see it (2026-09-01)

An inline `<clef>` governs every following measure of its staff until the next
one. The page refill finds "what changed" by diffing per-measure serializations,
so inserting a clef marked ONE measure dirty; the splice re-engraved that line
and left every line after it in the old clef — a wrong render, not a refusal,
and invisible to every gate that looks only at the edited line. It surfaced
because a new fixture set a clef and then made a splice-verified edit under the
reference gate, which compares EVERY mounted system: lines 4 and 5 were 960
units shorter than the reference and drew a G clef where it drew an F.

Mid-piece key/meter changes never had this problem because they live in a
section-level `<scoreDef>`, and `computeInteriorSig` already derives on any
change to those. Inline clefs are the same kind of state stored in a different
place. Fixed by folding every layer clef (position + staff + attributes, not
id) into that signature, and by refusing a scroll splice whose run's clef SET
changed.

- **Ask of every element the sig-diff treats as local: what does it govern
  beyond its measure?** Clefs, key/meter changes, octave displacements — any
  "until further notice" state must route to the whole-document path.
- **The reference gate is the only gate that checks what the edit did NOT
  touch.** Keep it wide (every mounted system) and keep running the suite under
  `HKL_INDEX_CHECK=1` — the standard command does not set it.
- **A guard that compares the old and new run measure-by-measure breaks the
  moment the runs differ in length.** The first version of the scroll guard
  joined one separator per measure; a past-end append creates a measure, so an
  empty old run compared unequal to a one-measure new run with no clefs in
  either, and every measure-count-changing scroll edit full-rendered. Compare
  the SET (concatenated tags), never the per-measure shape.

## The cursor is "past flat[c]", and fixtures that place clefs by arithmetic get it wrong (2026-09-01)

`locateCursor` anchors on `flat[c]` and inserts AFTER it. So `setClefAtCursor(v,
getMeasureStartCursor(v, k))` puts the clef after the measure's FIRST chord, not
before it; `+1` lands after the second; and the cursor at the barline (past the
previous measure's last chord) stores the clef at the END of the previous
measure — which renders identically to a measure-initial clef (Verovio draws
both before the barline) but is a different model form, and the range
serializer's leading-clef path is only reachable through the importer's
measure-initial form. The only public-API route to that form is: set the clef
past the first chord, then delete that chord. Three fixtures were written on the
wrong arithmetic and reported "cannot pose the case" until a probe printed the
layer after each candidate cursor.

Also found in passing: a clef set on an EMPTY layer (only a placeholder space)
does not roundtrip — `<clef/><space/>` loads back as `<space/><clef/>`, which
would render the clef at the end of the measure. Not fixed; noted for the
backlog.

- **When placing anything by cursor in a test, print the layer afterwards once.**
  The convention is documented, but "measure start" and "before the first
  chord" are different cursors under it.
- **A 50-measure fixture must declare `skipCursorTrace: true`.** The trace
  scrolls every stop into view; on a multi-page document that is minutes per
  fixture, and four such fixtures read as a hung suite.

## A geometry gate cannot see a same-width glyph swap — and a running context must not clear what it does not carry (2026-09-01)

Max's smoke test: any edit on the sonata's first line turned its cut-time
signature into "2/2"; remounting the page restored it. The window's range head
had lost `meter.sym`. `stampRunningCtx` wrote the running meter's symbol with
`if (sym) set; else remove` — unconditionally — and a range opening at measure
0 has an EMPTY running context (nothing precedes the target), so the head's own
`cut` was removed while its 2/2 stayed. Every mid-score window had the same
hole, hidden because the meter is only drawn on the discarded leader.

Nothing caught it because every gate we have compares GEOMETRY: per-measure
x/width and staff tops in the context check, `verifyAgainstReference`, and
`cb-startzone.js`. The cut-time glyph and the stacked "2/2" numerals differ by
a few units — inside `EPS` 25 — so a wrong glyph of the right width is invisible
to all of them, and no test document had a meter symbol to lose. The one thing
that DOES see it is the glyph census the refusal path now records
(`lastContextDiff`): `E08B` versus `E082 E082` in `g.meterSig`. Line 0 also
became spliceable only the day before, so the first render to expose the head
stamp to a visible meter was Max's.

- **A running context may only overwrite what it carries.** "No override seen"
  and "override with no symbol" are different states; collapsing them clears
  document truth. Guard every clear on the corresponding value being present.
- **Add a glyph-identity signal to the reference gate.** Geometry is necessary,
  not sufficient: clefs, key signatures and meter signatures can swap form at
  equal width. Codepoints per `g.clef`/`g.keySig`/`g.meterSig` per measure cost
  no layout flush and are exact.
- **Every test document is 4/4 without a symbol.** A fixture corpus with one
  shape of everything cannot catch a bug in the other shapes; when a feature has
  an attribute the corpus never sets, set it once somewhere.
- **"Nothing may change X on this path" needs its exceptions enumerated before
  it becomes a refusal.** Promoting the glyph check to the replaced lines
  ("a splice never changes a line's signatures — clef/key/meter edits derive")
  refused a legitimate splice within minutes: a relocated clef changes no clef
  yet redraws two lines' clef glyphs. The exemption (clef glyphs on clef-bearing
  lines) was cheap once named; the rule as first stated was one exemption short.
  Run the fixture set immediately after promoting any diagnostic to a gate.

## A fallback is not an invariant, and the replaced set is never a baseline (2026-09-01)

Two framing errors in one afternoon, caught by Max. First: mid-piece key and
meter changes had always derived, so when inline clefs turned out to leave
later lines stale I made them derive too, and then wrote "clef/key/meter edits
derive" as if it were a law of the system. It was a fallback with a date on it,
and each such fallback is an O(document) render the user did not ask for. The
correct model is that a signature change GOVERNS a range — to the next change
of the same kind on the same staff — and the edit path must be O(that range).
Second: on top of that "invariant" I compared the REPLACED lines' glyphs against
the pre-edit page, then exempted the case where the invariant failed. The
replaced set is by definition what Verovio was told to redraw; its post-edit
look is unknowable live, so any live comparison of it is a category error, and
the exemption was patching the error rather than the code.

- **When you find yourself writing "X always falls back to a full render",
  stop and ask what X actually governs.** The answer is a range; compute it.
- **Live gates compare only what the edit must leave unchanged.** Context lines,
  yes. Replaced lines, never — they belong to the reference gate, which compares
  them against a fresh full render under `HKL_INDEX_CHECK`.
- **An exemption bolted onto a new gate on its first run is a sign the gate's
  premise is wrong**, not that the world has an edge case.
- **The scroll splicer could not see a section-level scoreDef at all**, so a
  mid-piece key change in scroll view rendered nothing. A per-measure diff is
  blind to everything that lives between measures; enumerate those elements
  explicitly.
- **A refill that changes pagination full-renders WITHOUT consulting the page
  splicer and leaves no diagnostic** (`paginationHeld` false in
  `renderPageComposer`): `lastOutcome`/`lastSkipReason`/`lastDeriveReason` all
  keep their previous values. A fixture that read them after such a render saw
  the PREVIOUS render's "spliced" and passed the wrong assertion. Clear the
  splicer's diagnostics before an edit under test, and read
  `pb.lastRefillLines` + the line count when a verdict is missing. (A 4/4 → 2/4
  change halves every fill and merges lines — that is B2's class, so the meter
  fixture uses the width-neutral 4/4 → 2/2.)

## A verification that runs on every cache hit costs O(calls), and calls are O(edit range) (2026-09-01)

Under `HKL_INDEX_CHECK` the model re-enumerates `flatChildren` and re-checks
`allMeasures` on every cache hit — the right gate for the caching mechanism,
which was the risk when they were introduced. A one-note edit hits them a few
dozen times. A key change governing 17 lines hit them 4 751 and 25 121 times,
and the edit took 44 s in test mode against 1.2 s without the flag. Nothing was
wrong; the gate's cost model was written for small edits and never re-examined
when edits got large.

- **Verify a cache once per document version, not once per hit.** The
  guarantee is the same; the cost stops scaling with how often callers ask.
  (Done 2026-09-01: `measuresVerifiedVer` / `flatVerified` in the model. Sound
  because `ver` is drained from the MutationObserver at the top of the call —
  two hits at one version have zero records between them and read the same
  DOM.)
- **When a test-mode run is 30× slower than production, attribute it before
  reading it as a production problem** — the probe that wrapped the candidates
  found the answer in one run.

Second finding, same day: once-per-version took the key case from 45 s to 27 s,
not to ~2 s. `cb-checkcost.js` (wrap every flag-gated verifier with a timer, run
the edit flag-off then flag-on) attributed 24 of the remaining 25 s to ONE
`assertVoiceIndexConsistent` call: its per-stop helpers went through
`locateCursor`, which called the module-level `flatChildren` IMPLEMENTATION —
a fresh whole-document enumeration, 2.3 ms on the sonata — on every call, so
one cross-check of ~5 000 stops was 10 000 × O(document). `locateCursor` now
reads the model's cached stops (exact by the same MutationObserver; the cache
itself is verified on its first hit per version), and the cross-check is
0.8 s, of which 0.7 s is `getMeasureStartCursorUncached` (O(measure index) ×
447 measures — the known residual). Lesson: a cross-check "against the
original computation" inherits the original's cost model; when the original
was O(document) per query, calling it once per stop is O(document²). Check the
helpers a verifier calls, not only the verifier.

## Verovio's per-measure cost is the DRAW, and the first draw after a load carries the layout (2026-09-01)

Measuring the naturals window (`cb-naturalsalt.js`, 100 measures): `loadData`
64 ms, `renderToSVG` 335–453 ms. The design doc had framed the cost as
"`loadData` on one giant system" and hypothesised superlinear layout; pinned
lines cost the same. Two things follow for any Verovio timing here: (1) the
first `renderToSVG` after a `loadData` is 30–40% slower than a repeat on the
same data (460 vs 330 ms; 56 vs 43) — layout is lazy and lands in the first
draw, so a probe that times repeats under-reports production, which always
pays the first; (2) SVG string formatting is not where the draw time goes:
`svgFormatRaw` halves the bytes and cuts the DOM parse 36% but leaves
`renderToSVG` within noise. The lever on Verovio time is the number of measures
drawn, nothing else.

## A synthetic context element can be gate-only — check before pricing its removal (2026-09-01)

The splice window's leader (an mRest system absorbing score-start treatment)
looked like a cost worth cutting. `cb-windowalt.js` showed the replaced line
and the line below are geometrically identical without it (every measure
x/width, staff top, spacing, height: delta 0); only the context-ABOVE line
changes, i.e. the leader exists purely so the above-line gate can compare.
And leader + trailer together cost ~3 ms. Two lessons: a synthetic element's
job is either geometry or verification — establish which with a delta table
before assuming it is expensive — and measure its cost in isolation; the
earlier variant run had attributed 14 ms to them, which a second run showed to
be noise.

## Count forced layout flushes by timing the reads, not by counting calls (2026-09-01)

A6 had reduced `getBBox` calls 199 → 169 and measured no change, concluding
"flush-bound". `cb-splicecost.js` makes that operational: wrap every geometry
read with a timer and treat a call over 0.5 ms as a flush, recording its stack
frame. One steady-state edit has five flushes (naturals host 8 ms, first live
read 5.3, window-host profiles 3.5, post-surgery snap 4.5, overlay-height read
5.5 — the last is paint layout brought forward, not extra work) and ~230
sub-millisecond reads that cost nothing. The 5.3 ms live flush exists only
because the naturals host was attached to and removed from `<body>`, which
dirties the live page's layout — a host that is never attached (A7) removes
two flushes for one change. When a cost is "flush-bound", the design question
is which WRITES precede each expensive read, not how many reads there are.

## A bbox-based width includes whatever overhangs; the layout width is the staff-line span (2026-09-01)

Replacing the naturals window's `getBBox` reading with the staff-line path
extent was expected to be identical, and it was — except for a window's first
measure, whose bbox began 144 units left of its staff line because the
system-start brace/barline is drawn there. The old natural for measure 0
therefore included the brace, which Verovio does not count as measure width.
When a geometry read is defined by a bounding box, list what else can fall
inside that box before treating it as "the" width; and when replacing it,
prove equality over the whole document (`cb-naturalspath.js`), because the
exceptions will be structural (first/last of something), not random.

## A "could it differ?" trigger must key on the input that determines the value, not on things nearby (2026-09-01)

A7's first cut re-measured `sigW` whenever a naturals window contained a
scoreDef or an inline clef anywhere in its section — reasonable-sounding, and
on the sonata true for essentially every window (left-hand clef changes are
everywhere), so the cost the change was meant to remove stayed. The leading
clef+key is determined entirely by the folded head the range serializer writes
before `<section>`; keying the re-measure on that string is exact and fires
only when the leading context actually changes. When gating an expensive
recompute, find the exact input the value is a function of and compare THAT.

## Scoping work on an offscreen SVG host saves nothing while any read still forces its first layout (2026-09-01)

A8 cut the window host's post-processing from 20 measures to the 6 imported
ones and saved 6 ms of 30. The pass timings showed `snapBarlines` on ONE system
at ~22 ms: the first `getScreenCTM` on a freshly parsed page-sized host is that
host's initial layout, and every subsequent read is free. The cost of an
offscreen host is therefore roughly "one layout" regardless of how much of it
you touch — the only way to remove it is to read nothing that needs layout
(path data, `use` x/y, transforms; A7 did exactly this for the naturals
window). When timing DOM work on a host, look for the single expensive first
read before optimising what follows it. Corollary for probes: wrap
`getScreenCTM` as well as `getBBox` — it forces layout just the same and the
first attribution pass missed it.

## A lazy snapshot is sound only while nothing can change what it snapshots — enumerate the change points, and assert (2026-09-01)

Making the history AFTER serialisation lazy looked like a thunk. The hazard is
that the thunk serialises whatever the document IS when forced, so it must be
forced before ANY later document change: the next edit's BEFORE snapshot, an
undo/redo swap, a load. In Composer those are exactly `snapshotState` /
`snapshotStateReusing`, `restoreSnapshot*`, `replaceDocument` — every mutation
path goes through one of them first — plus an idle prefetch. Two design points
worth reusing: (1) put the materialisation hooks in the OWNER of the state (the
model), not in the consumers, so a new mutation path inherits them; (2) assert
the invariant with the exact version the model already has (throw under the
test flag when the version moved), so the suite catches a path that bypasses
it. And the comparison that would have forced the thunk (no-op detection by
string equality) can be deferred to the moment the thunk is forced anyway,
with a retraction — the version test handles the common no-op cheaply and
exactly.

## An idle-sliced task that is finished synchronously must also be disarmed — its queued continuation will run (2026-09-01)

`finishAdoptionNow` completed a pending adoption walk on demand and cleared the
owner's task reference, but the task's `scheduleIdle(step)` callback was
already queued. It fired later, saw nothing left to walk, and re-committed the
task's stale result over a newer partition. Any "finish now" path for a sliced
background task has to do what cancellation does — mark the task so the
queued continuation returns — or the commit must verify the task is still the
current one (both are now in place). The symptom class is a state write from a
stack that has no business writing at that moment; the diagnostic that found it
in one reproduction was a setter trap on the field (`Object.defineProperty`
with a recording setter, installed by the fixture and removed after) — far
cheaper than reasoning about every writer, of which there were four and the
right one was the least likely.

## Fixture assertions are template literals — backslashes in injected JS are template escapes (2026-09-01)

Instrumenting a fixture assertion with a regex (`/\(?https?:\/\/…/`) produced
three "no detail" failures and no other signal: the assertion `expr` is a
backtick template literal, so `\(` and `\s` were consumed as template escapes
and the evaluated code was a syntax error. When injecting code into
`fixtures.mjs` assertions, avoid backslashes entirely (`String.fromCharCode(10)`
for a newline, plain string methods instead of regexes), and treat a sudden
"no detail" across every instrumented fixture as your own syntax error, not
a product failure.

## A visual-baseline mismatch of a few thousand pixels traced along glyph edges is a fractional device-pixel shift (2026-09-01)

`pageSystemSpliceEdit` differed from its baseline once in full-suite order:
5 450 pixels (0.09%), all inside one system's band, following notehead and
brace outlines; identical on re-run. Max read it as a sub-pixel shift of the
spliced system; the candidates are a non-static vertical plan applying a
fractional `dy` (staff lines are re-snapped, the brace is not inside a staff
group) or a fractional `dx` un-snapping host-frame barline snaps. The visual
check now appends `window.__visualDiag` (the plan's static flag and each
replaced system's applied translate in user units and device px, recorded by
the fixture) to a mismatch's detail, so the next occurrence explains itself.
Pixel-diff a mismatch before reasoning about it: byte size and sha1 tell you
nothing; a highlighted diff and its row histogram told the whole story.

## Replace a layout-dependent read with a text read by proving BOTH sides equivalent on every real case, not by reasoning about one (2026-09-02)

A11 swapped `getBBox` geometry for staff-line path geometry in the page
splicer. The reasoning ("a measure's bbox starts at its staff line") was
wrong in two systematic ways — spanners overhanging into neighbours, and the
brace on system-first measures — and it did not matter, because the context
gate compares window against live and both carried the same pollution. That
is exactly the kind of fact you only learn by measuring: the proof probe
computed BOTH readings on BOTH sides for 117 real splices across every sonata
line and reported the gate verdicts, the staff tops and the placement dx/dy
under each basis side by side. Identical everywhere (Δ 0; the only nonzero
delta, ≤ 3 units, was the live right-edge snap, seen by both readings because
the snap rewrites the path). The method generalises: when changing what a
verification gate measures, run the old and new measurements together over
the whole corpus and diff the VERDICTS, not just the values — and keep the
probe, because the next change to what the snaps rewrite needs it again.

## The cost of an offscreen SVG host is its first layout; the way out is to read only text (2026-09-02)

Three steps taught this in order: A7 (naturals window: read staff-line spans
from a never-attached parse), A8 (scoping the passes on an attached host saved
6 of 30 ms because the first `getScreenCTM` still laid the whole host out),
A11 (the splice window itself never attached; the imported systems are
post-processed in the live page, sharing the one layout the post-surgery snap
needs). Rule: an offscreen host that anything measures costs one full layout
regardless of how much of it you touch; a `DOMParser` document that nothing
measures costs a parse. Design the reads first, then decide whether the host
needs to exist at all.

## A diff hunk with an EMPTY side is not an unchanged partition — two representation traps in one hour (2026-09-02)

B2 turned the page splicer's replaced set into a line hunk: prefix/suffix diff of
old vs new start ids, `(pre, suf)`, then union with the changed run. Two bugs
came straight out of the representation, both caught by the suite in one run:

- **Identical partitions read as "no suffix".** With `suf` clamped by
  `min(N, M) − pre`, an unchanged partition (pre = N = M) gives `suf = 0`, which
  is the same value as "the whole tail changed". Unioning the changed run then
  extended the replaced set to the END of the document: seven fixtures failed in
  seven different-looking ways (`run overshoots the reset`, `courtesyExt=0`,
  `dyFollow 0`, a "full render" verdict, two visual diffs) that were one bug.
- **An empty NEW side taken as "unchanged".** A whole deleted line leaves the
  new side empty (`a > bNew`) while the old side still holds the vanished line.
  Testing "unchanged" as `a > bNew` skipped the boundary rule and imported the
  successor line without removing its old system — the reference gate caught it
  as `rendered partition diverged`.

Rule: hold the hunk as explicit bounds on BOTH sides, test "unchanged" as
`N === M && pre === N`, and remember the old side is non-empty whenever the
partition changed at all (the line above a moved boundary joins the hunk). When
several fixtures fail at once in unrelated-looking ways after one change to a
shared computation, suspect the computation's degenerate case before any of the
symptoms.

## Carrying pagination by start ID moved a remnant line onto the previous page (2026-09-02)

The page carry in `tryRefill` kept a page's start ID while it still began a
line, else jumped to the next surviving old START. Delete only the first
measure of a page-start line and the id vanishes while the line survives (its
start moves to the next member): the carry skipped the remnant and the page
began one line later — the remnant landed on the PREVIOUS page, a pagination
change no edit asked for, and one that can overflow that page. Pages are runs of
LINES; carry them by line index through the membership carry and the repair
loop (`repartition` now returns both), and a surviving line can never change
page because of an edit. Only a page whose every line vanished collapses.

## Verovio warns about lines the legality band admits (2026-09-02)

`[Warning] Justification is highly compressed (ratio smaller than 0.8: …)` plus
three follow-up lines (`System full width`, `Non-justifiable width`, `Drawing
justifiable width`) is Verovio's `console.warn` on any render — window or live —
of a system it compresses below 0.8. Our legality band (`FIT_MAX 1.45`) admits
lines Verovio draws at ~0.69–0.73, so composing at the end of a score sits in
the warning zone one measure at a time, and a whole-note-per-measure fixture
sits there permanently. It is not an error and not a splice defect: the band
was set to contain the castoff's own envelope by OUR naturals model, whose
fill runs above Verovio's ratio on dense measures and below it on sparse ones.
The suite's console capture allowlists exactly this family
(`test/composer-test/lib/console-capture.mjs`); a fixture that hooks
`console.warn` itself must skip `^\[Warning\]` too, or it fails on the same
notice the runner already lets through. Whether the band should shrink is a D2
question for Max (design doc → Open work).

## Scripting a whole-measure deletion: switch the voice, and drift — never re-anchor (2026-09-02)

Three model facts bit the sonata battery's `delete-whole-line` edit in a row.
`setCursor(c, v)` moves voice v's cursor but `deleteAtCursor` acts on the
CURRENT voice — without `setVoice(v)` first, the voice-2 deletes landed in
voice 1 at voice-2 indices (the edit "succeeded", the document was wrong, and
every gate stayed green because the result was still self-consistent). A
deleted note is replaced by a `space` placeholder, so a "content count" never
moves. And a delete whose target is a placeholder is a skip-left by design, so
a cursor re-anchored at the measure's start or end stalls on the first
placeholder it meets. What works: per voice, park the cursor past the
measure's last stop and backspace WITHOUT re-anchoring until the cursor's
measure index drops below the target; once every voice has drifted through,
one delete at the (now empty) wrapper drops the measure. Verified over two
sonata lines (446 → 436 measures). The battery asserts `allEditsApplied` for
exactly this reason — an edit that silently did not apply reads as a passing
splice.

## A post-mount injection that grows a page's viewBox makes every later `pinExactScale` a 90 px jump — and header pages have been drawn 3 % small (2026-09-02)

Found by re-reading `cb-sweep.js`'s viewport counters after B2 (they had been
0/0 on 2026-08-31 and nobody had read them since): `pageBoxChanged 3`,
`scrollHeightChanged 6`, next-page anchor moved 90 px on exactly the sonata's
three movement-start lines. Mechanism, in order: `finishPageMount` runs
`pinExactScale` (root svg box = viewBox × device scale), THEN
`injectSectionHeaders` grows the inner viewBox by the 900-unit reserve. The
injector's own root-height update targets the inner `svg.definition-scale`,
which has no height attribute, so it has never run — a header page mounts with
a 28840-unit viewBox in a 2794 px box, i.e. drawn ~3 % smaller than its
neighbours (uniform `meet` scaling, slight horizontal inset), invisible to every
gate because they all compare user units. Since A8 (2026-09-01) moved
post-processing onto the LIVE page, the first splice on such a page re-ran
`pinExactScale`, which now saw the grown viewBox and resized the page by the
reserve: +90 px, every page below shifted, exactly the class of drift Max called
out on 2026-08-31.

Resolution (same day, Max): the growth itself was the hack. The paper is fixed
and the scale pinned at the box; a header is a component with a reserved height
in the page's budget, so the injector no longer touches the viewBox and a page
that no longer fits below its headers overflows into B2's cascade (decisions.md
2026-09-02, "Section headers are page budget"). The interim `data-hkl-vb-base`
stabilizer was reverted — and, it turned out, had never been served (see the
`packages/` dev-server lesson below). Two rules: read a gate's EVERY counter after a change,
not just the headline; and a post-mount injection must leave whatever a
later pass recomputes from either reproducible or recorded.

## The running dev server does not pick up edits under `packages/` (2026-09-02)

An afternoon of gates — scenarios, the full suite, the sweep — ran against a
`render-presets.ts` transform twelve hours older than the edit under test, and
the "fix" they were verifying was never in the page. The composer app's Vite
resolves `@hkl/notation` through the workspace symlink to `/@fs/…/packages/
notation/src/…` — outside the app root — and did not invalidate that module
when the file changed; `curl` of the file's other URL showed the new text,
which made the staleness invisible. Edits under `apps/composer/src` reload
fine. Rules: after editing anything under `packages/`, the dev server must be
restarted (ask Max) before any browser-based verification counts; and when a
change has no effect, read what the page actually loaded —
`performance.getEntriesByType('resource')` for the module URL, then `fetch` it
and grep for the change — before theorizing about the code.

## An inventory of a component's jobs must be checked against the code that READS it, not the comment above it (2026-09-02)

The design doc priced the splice window's context lines as "the live fidelity
test plus the courtesy the following line generates" (~60 ms of Verovio) and
framed shrinking the window as a gate question. `verticalPlan` reads the
window's L−1 and L+1 as the two ends of the spacing chain — geometry, not
verification — and the 2026-08-30 entry had said so; two later summaries
dropped the third job and the doc's START HERE inherited the loss. The
correction came from reading the consumer (`verticalPlan`, `dyFollow`) rather
than the producer's comment. Rule: before pricing the removal of anything a
splice renders, list every reader of it in the code and name each reader's
purpose; a comment that enumerates purposes is a claim, not the inventory.
Corollary from the same afternoon: the leader/trailer delta-table method
(`cb-windowalt.js`) answers "is this element geometry or verification" for a
SYNTHETIC element; for a REAL line the same table would have shown the
replaced system's staff top moving without the context line — run it before
believing an element is gate-only.

## A multi-page window's SVGs are one DOMParser document PER PAGE; ids do not compare across runs (2026-09-02)

Two probe faults found while proving the courtesy stub, both silent:
- Concatenating `renderToSVG(1) + renderToSVG(2)` into one string and parsing
  it with `DOMParser('image/svg+xml')` is not XML (two roots); the parser
  returns a document that still answers `querySelectorAll('g.system')` — with
  only the FIRST page's systems. 98 of 107 sonata windows are two or three
  pages, so the first proof run compared truncated system lists on both builds
  and looked clean. Parse each page separately (`spliceDom` already does).
- Measure ids are `m-<seq>-<rand>`: the suffix is regenerated on every import,
  so a hash of the window MEI, or any id equality, is meaningless across two
  runs of the same probe. Compare by position, or by the id's stable prefix.
Both are the kind of fault that makes a "delta 0.0" table lie in the direction
of agreement; a proof probe's first run should include one case that MUST
differ (here: the extension line present on one build, absent on the other)
and fail if it does not.

## A calibrated constant you cannot derive is a component you have not named (2026-09-02)

Calibrating Composer's page-placement rule against Verovio's pages left one
number with no derivation: every page's first system sat 5.25 units below
where `max(above, F)` put it, on all 29 header-less-looking pages, exactly. It
went in as `C0` and the first owned build crowded every score title — because
the 5.25 units were Verovio's autogenerated page-number header (bottom at 255
units + a 2-unit `bottomMarginHeader` = 415 ≈ 420), and page 1's header is the
title, taller. The constant was a component (the page header) measured on
pages where it happened to have one height. Rule: when a fit needs an
unexplained constant, look for the element whose size it is before shipping
the number; `cb-pghead.js`-style, list the page-margin group's non-system
children and their bboxes. Corollary: Max found it in the screenshots in
seconds ("anywhere there is a score title") — the two-images rule earned its
keep again.

## Verovio's paper frame is the INNER svg's viewBox; the outer one is in tenths (2026-09-02)

A Verovio page is `<svg viewBox="0 0 2159 2794"><svg class="definition-scale"
viewBox="0 0 21590 27940"><g class="page-margin" transform="translate(1400,
1400)">…`. Everything inside the margin group — staff lines, transforms,
extents — is in the inner frame. `pageEl.querySelector('svg')` returns the
OUTER one; reading its viewBox height as the paper bottom made the predicted
fold ten times too small and every page "overflowed" at its first system. Use
`margin.closest('svg')` for any frame arithmetic, and keep the measured fold
cross-check under the flag — it is what caught this in the first fixture run.

## Verovio's commented-out code is a drift hazard for anything that models its layout (2026-09-02)

Composer's placement rule restates Verovio 6.3's page stacking (`max(below,
F) + G + max(above, F)`, F = 6 units, G = 4). Reading `AlignSystemsFunctor::
VisitSystem` for it turned up the overflow-aware inter-system variant PRESENT
in the source and commented out — one uncomment away from every gap on every
page changing under a Verovio upgrade. A model of a library's layout must
record which branch of the source it restates (decisions.md "Composer owns
height" does), and any Verovio upgrade must re-run the calibration probe
(`cb-placement.js` on both builds) before the rule is trusted again. More
generally: when modelling behaviour from a library's source, note the
commented-out alternatives next to the constants they would change — they are
the most likely future diff.

## A fixture that returns "no detail" has a SyntaxError, not a missing detail (2026-09-02)

The composer-test runner evaluates an assertion as `JSON.stringify(await
Promise.resolve(<expr>))` inside an in-page try/catch. A parse error in
`<expr>` never reaches that catch — the wrapper itself fails to parse — so
`Runtime.evaluate` returns an error OBJECT, which the runner used to stringify
and report as `no detail`. Two fixtures showed it after a scripted edit wrote
`'page 2\'s'` where the template literal needed `'page 2\\'s'`; the raw
value only came out through `inspect.mjs`, which printed the SyntaxError.
`lib/cdp.mjs` now returns `exceptionDetails` as `__error`, so the failure names
itself. Rules: "no detail" from an assertion is a broken expression, look at
the last edit to it first; and when a script writes fixture code into
`fixtures.mjs`, use raw strings — every backslash in the `expr` template
literal must arrive doubled.

## The universal invariants mount every page — a fixture about placeholders must unmount first (2026-09-02)

The cursor trace and the other universal invariants run BEFORE
`FIXTURE_ASSERTIONS`, and the cursor walk calls `ensureMeasureMounted` on every
position, so by the time an assertion runs the whole document is mounted and
the extents job (armed at render time) has usually finished in the RAF waits
between invariants. `pageExtentsJobScrollDuring` first read "page 3 is not a
placeholder (pending: [])" and "extents job not armed" for exactly this
reason. A fixture about unmounted pages or an in-flight idle job must build
its own state: disconnect the IntersectionObserver, `unmountPage` what it
needs pending, clear the store it is testing, re-place the mounted pages and
arm the job itself — then assert.

## Adding a section header is a DERIVE, not a splice — spill a page with content edits (2026-09-02)

`setSectionHeaderAt` changes the user-break signature (`computeUserBreakSig`),
so `tryRefill` bails with `user breaks changed` and the render derives.
`pageSectionHeaderOverflow` never asserted a splice, which is why nobody
noticed; `pageCascadeArithmeticPastMount` did and got `noop`/`derive`. To make
a page spill inside a splice, grow its systems with content edits (the
c0..g7 chord of `pageSystemSpliceCascadeOverflow`), not with headers.

## A signature that encodes POSITION cannot answer a question about IDENTITY (2026-09-02)

`computeUserBreakSig` guarded the refill against user-break changes by walking
the section stream and recording each `sb`/`pb` as a running MEASURE COUNT plus
its tag, giving strings like `230sb`. The question it exists to answer is "did
the user's break structure change", which is about WHICH MEASURES start lines.
Encoding it by count aliased position onto identity: inserting a blank measure
anywhere above a break shifted every later count, so Ctrl+M insert-measure
tripped the guard and derived. On the sonata that was 2.8 s for an edit whose
break structure had not changed at all, and it went unnoticed because no gate
asserted that a command splices. Now keyed on the `xml:id` of the measure each
break precedes, which is invariant under insertions elsewhere and still changes
when a break is added, removed or moved. Rule: when a signature guards a
STRUCTURAL question, key it on the identities the structure is made of, never
on ordinals; an ordinal signature reports every edit above it as a change.

## O(spanners × measures) attribute queries: the third instance of one shape (2026-09-02)

`insertMeasureAt` found the measure of each slur endpoint with
`measures.findIndex((m) => m.querySelector('[*|id="..."]'))`. On the sonata,
922 slurs over 446 measures came to 432 154 `querySelector` calls, 406 ms of a
523 ms mutation, and it was most of why inserting a blank measure cost about
four times a note edit. One pass that maps the wanted ids to measure indices
took it to 450 queries and 57 ms.

This is the same defect as `expandForSpanners`' growth loop, which re-queried
every measure's subtree on each iteration and accounted for the bulk of ~32 000
DOM queries per keystroke, and as the naturals `sigW` measurement before it was
made conditional. The shape to watch for: a per-element lookup written as a
`find`/`findIndex` over a container list with a query in the predicate. It
reads as O(n) and is O(n × m). Whenever the answer is "which measure holds this
id", build the id map once. `cb-splicecost.js` counts `querySelector` and
`querySelectorAll` per phase, so this shape is one probe run away from being
visible; a mutation phase with six-figure query counts is the tell.

## "Localized edit" has two halves: what must RE-FLOW and what must RE-DRAW (2026-09-02)

The page refill computed ONE changed run and used it for both the partition
repair (with its naturals width measurement) and the splice's replaced set.
Those answer different questions. Inserting a measure renumbers every measure
to the end of its section, and measure numbers ARE rendered, so all of those
lines must be redrawn — but a number is an overlay label above the staff, so
none of their widths or fills move and the partition cannot change. Conflating
the two spent 675 ms measuring 134 naturals that could not have differed.
Whenever an edit's dirty set looks too wide, ask which half each member belongs
to before trying to shrink it: the answer here was not "dirty fewer measures"
(they really did change) but "re-flow fewer than you re-draw".

## Work proportional to the DOCUMENT hiding inside work proportional to the EDIT (2026-09-02)

Page view mounts a handful of pages, and every deferral mechanism for the rest
existed — stale pages, lazy mount, the cascade's arithmetic steps. The splice
still computed its replaced set in line space over the whole document and then
called `ensurePageMounted` on every page that set touched, drawing eight
off-screen pages (834 ms) so one window could re-engrave 146 measures (650 ms),
on the keystroke. It was written when a missing page meant a refusal and a full
render, so mounting at ~50 ms was strictly better; when the splice learned to
do partial work the tradeoff inverted and nothing revisited the call site.
Rule: an eager fetch justified by "the alternative is the slow path" must be
re-examined every time the slow path changes. And when a latency number scales
with the document rather than the edit, look for a call that materializes
something off-screen before assuming the algorithm is wrong.


## Two hand-maintained lists that must agree WILL drift — derive one from the other (2026-09-03)

`render/splice.ts` held `SPANNER_NAMES`, the set of MEI control events the
window-expansion pass understands. `model/index.ts` held
`CONTROL_EVENT_NAMES`, the set the model understands. The second was a
superset, and nothing checked. `tempo` was in the model's list and not the
window's — and a GRADUAL tempo (accel./rit.) carries `@tstamp2`, so it spans
measures exactly like a hairpin. The window vocabulary is now DERIVED from the
model's set, which makes the drift unrepresentable rather than merely fixed.
Point events (fermata, artic, breath, reh, caesura, the ornaments) come along
and cost nothing: they resolve to one measure and can never grow a window.
Rule: when a second list exists because the first "has extra entries we don't
need", derive and let the extras be inert — the review that keeps two lists in
step does not happen.

## Prove a suspected gap is a real DEFECT before reporting it as one (2026-09-03)

Finding `tempo` missing from the window vocabulary, the obvious inference was
the 2026-08-30 wedge defect: window fails to reach `@tstamp2`, Verovio warns
and drops the mark, the splice transplants the loss. It reads as certain and it
was wrong — `cb-spangaps.js` probe A shows Verovio draws no extension line for
a gradual tempo, so the host measure renders identically whether or not the
`@tstamp2` target is in range, and a short window lost nothing. The sibling gap
found the same way WAS live: `@tie="m"` (the medial note of a 3+-note chain)
set neither tie edge, and probe B shows the medial measure rendered alone draws
no tie where the full render draws one. Same investigation, same shape of
argument, opposite verdicts. Rule: a coverage hole in a list is a hypothesis
about rendering, not an observation of it. Render both sides and diff before
writing "this drops the spanner" anywhere.

## A censusing gate must count what a system draws OUTSIDE its measures (2026-09-03)

The reference gate gained a per-measure glyph-class census so an equal-width
content loss (a dropped slur segment, a missing articulation) could not pass a
geometry-only comparison. Per-measure alone would have missed the very defect
it was built for: Verovio draws the CONTINUATION segment of a spanner that
crosses a system break as a direct child of `g.system`, outside every
`g.measure` — 4 slurs and 9 ties on the sonata's mounted pages. A too-small
window drops exactly those. The census is therefore per-measure PLUS a
per-system residue, and `pb`/`sb` are excluded because `injectPins` upgrades a
page start's `<sb>` to `<pb>` in the render copy, so the two sides
legitimately disagree on that one class. That exclusion was measured, not
assumed: before it, it was the ONLY divergence reported across all 377
fixtures, which is also what says the census is tight rather than noisy.

## A fallback that refuses for the WRONG reason hides real defects behind a green suite (2026-09-03)

The page splice compared the edited line's neighbours against the mounted page
and refused when they diverged. Removing it (Phase 3) immediately surfaced two
pre-existing defects the reference gate had never been able to see, because on
those documents the splice always refused and fell back to a full render — so
the gate, which only runs after a splice LANDS, never ran: the splice window
and the gate's own reference were built with different Verovio options than the
pages were painted with, and last-system justification was governed by
Verovio's 0.8 default rather than by our `MIN_FILL`. Neither had a failing
test. Rule: a fallback whose trigger is broader than its stated purpose is not
a safety net, it is a mask — and the tests that pass because of it are not
evidence. Ask what a guard is preventing you from OBSERVING, not just what it
is preventing.

## Identical output hashes across two option values do not exonerate the option (2026-09-03)

Three visual baselines changed. Their diff hashes were byte-identical between a
run at `minLastJustification: 0` and one at `0.65`, and the conclusion drawn —
"justification is ruled out for all three" — was wrong for one of them. Before
either run the option was unset, i.e. Verovio's default 0.8, and a final line
whose fill sits in [0.65, 0.8) justifies at both 0 and 0.65 while staying
unjustified at 0.8. Identical hashes at two values are exactly what that looks
like. Comparing two candidate values says nothing about the value that was
actually in effect. Rule: A/B against the state you are replacing, not between
two states you are choosing among — reverting the suspected change and
re-running is one command and it settles what inference cannot.

## When a gate fires on your change, measure the quantity's EXISTING distribution first (2026-09-03)

The page-splice reference gate threw on one position out of 115 after the Phase 3
window change, and an hour went into "what did I break". The first move should
have been one census run over the UNCHANGED build asking "how exact is the
splice normally?" — which, when finally run, showed 328 of 338 (edit, page)
pairs deviating on BOTH code states, a median around 9 units, and the
pre-change build worse at the extreme (76.3 units against 57.6). The change had
not introduced anything; it relocated which page carried the outlier. A gate
firing tells you a threshold was crossed, not who crossed it, and the cheapest
way to find out is always the baseline, never the mechanism. Establish the
before-distribution of the exact quantity the gate measures before forming a
single hypothesis about your own diff.

## A tolerance gate cannot certify exactness — know what your instrument can say (2026-09-03)

`verifyAgainstReference` compares placed staff tops with `TOL = 30` units. That
gate can report exactly one thing: "nothing exceeded 30." It was read, for a
long stretch, as "the spliced page equals a full re-engrave" — and separately a
throw was read as "this edit changed something". Neither is a statement the
instrument can make: "exact" and "29 units off on every system of every page"
are identical to it, and they turned out to be the difference between the
contract holding and the contract never having held. Two structural blind spots
compounded it: the tolerance itself, and the fact that the gate verifies only
`touchedPages`, so whether a large deviation is even LOOKED at depends on which
pages an edit happened to touch — which is why one build looked clean and
another did not while their deviation distributions were identical. Before
citing a check as evidence, state what it can distinguish; if the question is
about magnitude or distribution, a pass/fail threshold is the wrong tool no
matter how it is squinted at.

## In an A/B, the control must cover the same population as the treatment (2026-09-03)

The treatment was swept over all four chunks of the document (115 edits); the
control was run over one chunk (28 edits), came back clean, and was reported as
"this is new with the change". The control build's own outlier lived at lines
83-87, in a chunk that was never run. Partial controls do not produce weaker
conclusions, they produce confidently wrong ones — the missing 75 % is exactly
where the counter-evidence was sitting. Sample the control over the same range,
the same positions and the same conditions as the treatment, or do not claim an
attribution at all.

## A measurement harness is unvalidated code — prove it on a known case first (2026-09-03)

Diagnosing the above produced three bespoke screenshot harnesses and every one
was wrong in a way that published a confident false claim: a synthetic panel
whose page height was derived arithmetically from two panel offsets (a constant
misalignment that reported "13.8 % of the page differs, whole page shifted"); a
capture that set `container.scrollTop = 0` and so photographed page 1 while
claiming to show page 28; and a capture taken after the sweep's restore had
already run, so both images were of the restored document rather than the
diverging state. A fourth error compared measured absolute tops against
`placeFor` output, which lives in a different coordinate origin, and reported a
constant 1395-unit "drift". The project already had a working capture-and-diff
path; the correct comparison needed no cropping or alignment at all — capture
the spliced state, force a full re-engrave, capture again, same container and
same code path. Rule: new measurement code earns trust by reproducing something
already known before it is allowed to report something new, and existing
verification tooling is preferred over anything invented mid-investigation.

## "Minor, triage it separately" is not available before the cause is known (2026-09-03)

A ~1.6 px placement deviation was twice proposed for deferral — once as
"negligible, 0.03 staff spaces", once as "log it and close the phase" — before
anyone understood it. Max: *"This is a minor divergence and the effect is
minimal, but it is a canary... Reseed is the safety valve in case something
changed for a good reason. That may be what we end up doing here, but not
before the reason is established."* Deferral and baseline reseeds are for
changes whose cause is understood and accepted; reaching for them to turn a red
gate green is precisely how a systemic defect survives — in this case one where
the splice had never satisfied its own correctness contract and no test could
say so. The size of a symptom is not evidence about the size of its cause.

## A correction computed against the SCREEN is not a property of the music (2026-09-03)

Composer's staff crisping asked "what nudge puts this staff line on the device
grid?" — a question whose answer depends on where the render happens to sit. A
system engraved in a splice window sits at a different raw `y` than the same
system in a full page render (measured: `lineY` 6255 vs 6812, different
residues mod the pixel grid), so the two computed different corrections for
identical music. The correction then landed in `staffTop`, `measureExtents`
folded it into `above`, and placement — which consumes `above` — put the system
a whole pixel off. The fix was to make the correction relative to the system's
own first staff row, which is intra-system geometry and therefore identical in
any render, and to let the system's placement carry the screen-dependent phase.
Rule: anything a layout DECISION consumes must be a function of the content,
not of where the content was drawn. If a measured input carries the render's
origin, every decision downstream of it inherits that origin.

## "Displaced but still crisp" is the signature of a snap that is not canonical (2026-09-03)

Whole systems on page 4 sat one to two device pixels from where a full
re-engrave put them — every element in them visibly displaced — while an audit
of all 150 staves found ZERO off the pixel grid. Both facts were true: each
staff had been snapped, but the two renders had snapped to DIFFERENT grid
points, because "nudge to the nearest grid line from wherever you are" is not a
canonical function. It admits many valid answers, and independent renders pick
different ones. Max, on seeing the diff: *"the problem is that this means one
of the staves is not being snapped to the grid... am I wrong?"* — the right
instinct, and the reason the search moved from placement arithmetic to the snap
itself. Rule: a snap must be a pure function of the thing being snapped, not of
its current position; and "everything is on the grid" does not imply "everything
is on the SAME grid point".

## Optimising the diagnostic instead of the deliverable (2026-09-03)

Several hours went into driving one census number — `placeFor(reference)` vs
`placeFor(live)` — up and down by ±10 with changes whose only justification was
that the number moved. That census re-derives where systems WOULD go from the
live page's extents; it is a useful diagnostic but it is not the contract, and a
page can be perfectly correct while it disagrees. The contract is the
reference's placement against where the systems ACTUALLY sit, and the ground
truth beneath both is the rendered pixels. Two changes that "improved" nothing
(quantizing every term; quantizing `above`) were only exposed as regressions
once the pixel comparison was run. Rule: identify which number IS the
deliverable before tuning any number, and keep a ground-truth check — here, a
screenshot diff — in the loop, so a metric that drifts away from reality is
caught in one step rather than five.

## Anything running after the pass that MEASURES geometry must not change geometry (2026-09-03)

Composer's page pipeline is `postProcess → placePage → injections`. `placePage`
measures each system's extents (`above`/`below`/`span`) and consumes them to
decide where every system goes, so a system's extents feed the position of every
system below it. Three separate defects turned out to be the same mistake — a
pass that mutates geometry running after that measurement:

1. `snapStaffLinesToGrid` moved `g.staff` by ≤ ½ device pixel for crispness,
   after placement. A page ended up at `snap(place(x))` while re-measuring said
   `place(snap(x))`. Every page was 0-10.6 units off its own rule.
2. `styleVoltaNumbers` restyles a tspan inside `g.voltaBracket` — font-size,
   family, weight, and appending a '.' — which changes the bracket's bbox. A
   volta is content ABOVE the staff, so it changes `above`, and the mount path
   ran it after `placePage` while the SPLICE path ran it before. The mounted
   page sat 20 units low from the volta system down; the gate then read that as
   a splice defect, and it was nearly "fixed" by widening the tolerance.
3. The reference gate's own offscreen host was aligned under a premise
   (`sysTy` is a whole number of pixels) that is true for a placed live page and
   false for a raw render — so the comparison measured the harness.

The invariant, now stated at both call sites: **anything running after
`placePage` may only write OUTSIDE `g.system`.** The two surviving injections
qualify — they append `text` as direct children of `g.page-margin` — so this is
checkable rather than remembered. When adding a pass to a render pipeline, the
question is not "does this look cosmetic" but "does anything downstream MEASURE
what I am touching"; a ½-pixel restyle of a volta number moved four systems.

## An edit during a probe run is a corrupted run, not a flaky probe (2026-09-03)

Two census chunks failed mid-sweep with unparseable output. The cause was
editing `apps/composer/src` while the run was in flight: Vite HMR reloaded the
module under the running browser. CLAUDE.md's standing trap says exactly this
("no `apps/composer/src` edits while anything runs against the dev server") and
it was still easy to violate while iterating quickly, because the failure looks
like probe flakiness rather than self-inflicted. Partial results from such a run
are also stale in a subtler way: they were produced by a mix of two code states.
Re-run from scratch; never reason from the surviving chunks.

## Verovio's `renderToSVG` is not idempotent for the running page header (2026-09-03)

Rendering a page a SECOND time from the same loaded document moves its `pgHead`
text. Measured (`cb-hdrdet.js`, sonata, one pinned MEI, one options object):
pages 1-5 render at y 371/195/194/194/197 on the first pass and
371/197/197/197/197 on the second. A fresh `loadData` followed by a single
render is perfectly deterministic (194 five times running). It is NOT order
dependence — page 3 reads 194 whether it is rendered first, after pages 1-2, or
after page 5 — and not toolkit-instance specific.

This matters because Composer's `firstContentTop` measures that header's bbox
and places every system on the page relative to it, and pages go through a
variable number of renders (initial mount, re-mount, the reference gate's own
render). So a live page's header can sit ~3 units from a freshly rendered one,
and the device-grid quantization turns that into a clean whole-pixel shift of
the entire page. It presents as a residual that is always EXACTLY one pixel, on
a stable set of pages, and that does not respond to ANY change in our own
placement code — which is the tell: when a deviation is invariant under every
local change, stop editing local code and check whether the renderer is
deterministic.

Pre-existing and not Composer-specific — a re-render has always shifted the
header fractionally; owning vertical placement only made it visible as a whole
pixel. Accepted rather than worked around (`TOL` = 10, one device pixel). The
fix, if it is ever worth it, is to stop feeding a renderer-measured header into
layout: treat the page header as a fixed reserve like `SECTION_HEADER_RESERVE`.

Two false trails on the way, both plausible and both wrong: a stale mounted page
(the edit provably changes no header y — identical before and after on every
page), and a page borrowing another page's header (197 also being page 5's value
is coincidence). The decisive experiment was the cheap one nobody had run:
render the same page twice and compare.

## Record the PROCESS corrections, not just the technical findings (2026-09-03)

One session produced sixteen lessons entries — every one about the code
(placement, tolerances, Verovio determinism) — and not a single line about how
Max had asked me to work, despite five separate corrections on exactly that:
show a diff HEATMAP rather than side-by-sides, surface the image before the
numbers, diff self-consistency rather than baseline-vs-output, stop cropping and
shifting, stop narrating instead of showing. Worse, the existing memory on that
topic still told a future session to "open BOTH files" — the superseded form —
so the next agent would confidently repeat the thing I had just been corrected
for three times. A different agent on another thread noticed the gap before I
did.

The asymmetry has a cause worth naming: a technical finding feels like a
discovery and gets written up, while a process correction feels like being told
off and gets *obeyed* instead of recorded. Obedience lasts one session; the
record is what survives it. CLAUDE.md already routes this class to memory as
`feedback` — the rule was there, the discipline was not.

Rule: when a correction arrives about HOW to work — what to surface, in what
form, in what order — write it down in the same turn, and check whether an
existing memory now contradicts it. A convention repeated twice in one session
is a convention that was never recorded.

## Rule v2 made placement non-local within a page (2026-09-04)

Vertical distribution changed the SHAPE of the placement dependency, not just
its arithmetic, and that is the part that bit. Under rule v1 a system's top was
a running sum down the page: it depended only on the systems ABOVE it. So a
code path could add, remove or resize a system near the bottom of a page and
the systems above it were still correct without re-placing anything. Under rule
v2 the page solves one water level over all of its gaps, so every system's
position depends on EVERY system on the page — including the ones below it.

Four paths change a mounted page's system set. Three re-placed the page already
(the splice's "place every touched page", the cascade's transplant, the
last-page spill). The fourth, `lazyMoveOut` — the arithmetic step that empties
a block off a mounted page when the receiving page is a placeholder — did not,
because under v1 it provably did not need to. It became a page-wide defect the
moment the level existed: the reference gate reported the spilling page's
systems each shifted down by a bit more than the one above it, which is what a
disagreeing LEVEL looks like (a per-gap constant), as distinct from a page
shifted by a constant (a frame error) or one system out of place (an extents
error). Reading that staircase off the heatmap is what identified it.

Rule: when a placement rule stops being a running sum — when any per-page
quantity is solved over the whole page — re-audit every mutation path, not just
the arithmetic. "This path didn't need to re-place" is a claim about the OLD
rule's locality and it expires with it.

Corollary, learned the expensive way in the same session: that one missing
re-placement also produced a symptom nowhere near itself. Eight unrelated
glyph-level visual fixtures started failing with a pure 8-pixel HORIZONTAL
translation (zero residual after the shift, both 8-pixel bands free of ink),
which is impossible for a vertical change to cause directly. It was the
mis-placed page changing the content bounding box that `visualCheck` derives
its capture clip from, in a later fixture, in the full tier only. Two symptoms,
one cause. Before theorising about the harness, check whether a known defect
upstream explains the framing — and note that the fixtures passed in `scenario`
and `visual` tiers and failed only in `full`, which was the tell that state was
carrying rather than rendering changing.

The framing record now names its own inputs: `visualMeta` carries `clip`,
`vpW`/`vpH` and `leftEl` (the element that sets the content box's left edge),
because a content-derived clip that moves is indistinguishable from a rendering
bug without them.

## Snapping is an output transform, never an input (2026-09-04)

The accepted one-device-pixel residual in placement is nondeterministic
sub-pixel geometry (Verovio places content ~2 units differently between a
windowed render and a full one) snapped ONCE to the crisp grid. That is fine as
long as the snap is the last thing that happens. It was not: `layoutSystems`
accumulated the next system's position from the previous system's SNAPPED top
(`y = top + …`), and `distributionExtras` solved the page's water level from
snapped tops and content bottoms. A system's ≤½-pixel rounding was therefore
the next system's premise, and the level — shared by every system on the page —
was a function of one system's rounding. Two units of noise in one `above`
became a 20-unit (2-pixel) displacement of two systems on sonata page 18, and
a staircase of per-system shifts the reference gate could see.

Two attempts to fix it by rounding BETTER both failed, and both were the same
mistake: quantizing `above` (Phase 3.5, measured 280 exact → 212) and
quantizing the level (this session: 7 deviating pairs at most 20 units → 13 at
most 40). Rounding a noisy input near a boundary amplifies it. The defect was
never the rounding; it was that a rounded value was an INPUT at all. Max's
statement of the rule: *"A snapped position should NEVER inform other
positions. Snapping should be done at the very end of the positioning, and
ONLY be used in the last phase of visual output, NEVER as a cascade input."*

The fix is one line of intent: accumulate on `rawTop`, solve the level on
unsnapped geometry, emit the snapped `ty` and nothing else. Measured: battery
deviations 7 → 4 and max 20 → 10 (every survivor a single system at the
accepted residual), the gated sweep 4/25 → 0/25 and then 0/115 on the first
fully reference-checked pass.

Phase 3.5 had already found and fixed exactly this shape one level down —
`alignStaffRows` makes staff-row corrections RELATIVE so a render's arbitrary
origin cannot leak into `above` — and the same mistake was sitting one level up
in the system accumulator. When a rounding step exists anywhere in a pipeline,
audit every consumer of its output: if anything downstream computes a position
from it, the pipeline is rounding twice.

Related, from the same session: three sonata probes had each reconstructed the
gate's reference preparation by hand and each had drifted from it (undistributed
placement; no `alignStavesIn`; no `decorateHost`). Every drift reported rule v2
as a product defect. A probe that re-implements a gate step will diverge from it
eventually; prefer calling the gate's own helper.

## Two harness traps from the same afternoon (2026-09-04)

**`TMPDIR` breaks the test runner's Chromium.** Both `run.mjs` and the phasec
runner launch headless Chromium with `--user-data-dir` under `os.tmpdir()`;
Chromium ALSO honours `TMPDIR` for its own sockets, and with it pointed at the
session scratchpad the debug endpoint never comes up. The runner reports exit 2
for every fixture — an infra failure that reads exactly like "the fixture did
not run", and cost two rounds of looking for orphaned browsers and stale ports.
Confirmed by running the fixed source with and without the override. Do not set
`TMPDIR` for these; their defaults are already under /tmp.

**`run-unfixed.sh` proves less than it says when a fix rides a same-tree
feature.** It stashes all of `apps/composer/src`, so "unfixed" means HEAD. The
`lazyMoveOut` re-place is only wrong under rule v2; on HEAD (rule v1) skipping
it is correct, so its fixture passes on the "unfixed" build legitimately, while
`pagePlacementOwned`'s snap-as-output assertion fails there as it should. Prove
such a fixture by reverting the single line on the current tree and running the
scenario — which is what was done.

## Verovio courtesy signatures: what suppresses them and what does not (2026-09-04)

Verovio 6.3 draws a cautionary key + meter at the end of a system whenever the
next system's first measure carries a new `<scoreDef>` — the condition in
`ScoreDefSetCurrentFunctor::VisitMeasure` is `m_currentSystem &&
m_upcomingScoreDef.m_setAsDrawing && m_previousMeasure && !m_restart`. There is
no option (221 options grepped for caut/court: none). Probed against the live
toolkit, all on a two-staff doc with a key + meter change over an `<sb>`:

- `keysig.visible="false"` / `meter.visible="false"` on the scoreDef: IGNORED —
  the signatures and the cautionaries draw exactly as without them.
- Layer-level `<keySig>`/`<meterSig>` in the first measure INSTEAD of a
  scoreDef: no cautionary, drawn right after the clef — but they do not
  persist: the section's later systems show the OLD key. Not a substitute.
- `<section restart="true">`: the scoreDef must be the FIRST thing after the
  section start (`ScoreDef::IsSectionRestart` looks at its previous sibling;
  an `<sb>` in between defeats it). It drops the KEY cautionary only —
  `SetCautionaryScoreDefFunctor(…, restart=true)` calls `SetDrawKeySig(false)`
  and nothing for the meter — and it redraws clef + key + meter at the restart
  measure (`REDRAW_ALL`) and draws the full staff labels (`m_drawLabels`), so
  the system is indented like the score's first.
- `meter.form="invis"` on the scoreDef blanks EVERY meter drawn from it — the
  courtesy and the restart's redraw — as a zero-width `g.meterSig` that still
  reserves about half a staff space; it does not leak into a later meter
  change (a following `<scoreDef meter.count…>` draws normally). A layer-level
  `<meterSig>` in the first measure then draws the visible one in the right
  spot (clef, key, meter).
- A content-less nested `<section restart="true"><scoreDef/></section>` inside
  the one big `<section>` works — Verovio's milestone conversion makes the
  section start the scoreDef's previous sibling — and leaves every measure a
  direct child of the outer section, which is what the whole break/splice
  pipeline assumes.

Composer's recipe is the sum: restart wrapper + invisible meter + layer
meterSig, on the render clone (`notation/sectionRestart.ts`). The upstream fix
would be two lines in `SetCautionaryScoreDefFunctor::VisitStaff` (also disable
the meter under restart).

## Verovio rests: `@visible` is ignored, `@loc` is honored, and twins at one `@loc` do not collide (2026-09-04)

Extends "Verovio doesn't honor `@visible="false"` on rests": a hidden rest not
only draws, it DISPLACES the other layer's rest exactly like a drawn one
(visible quarter rest in layer 1 pushed to centre-y 245 above a staff at
560–1200 by a hidden layer-2 rest). `@loc` on `<rest>` and `<mRest>` is
honored as a raw staff-line location (0 = bottom line, 4 = middle, 8 = top);
the single-layer defaults are loc 4 for everything except whole rests and
`<mRest>` (loc 6 — they hang from the fourth line; pinning a whole rest to 4
hangs it from the middle line, wrong). Two identical rests pinned to the same
`@loc` at the same moment render at the same x with no horizontal collision
shift — one glyph on top of the other. A rest pinned to `@loc` against a NOTE
in the other layer at the same moment simply collides with it, so pin only
when the other layer is void or an identical rest (`notation/restlayout.ts`).

## Verovio `spacingStaff` floors EVERY staff pair; `staffDef@spacing` is the per-pair lever (2026-09-04)

Raising `spacingStaff` (12 → 16 → 20) widened the viola→piano gap AND the
piano's inner gap identically; `spacingBraceGroup` only ever raises the inside
of a brace. There is no option that separates instruments more than a grand
staff's staves. MEI's `staffDef@spacing` — "distance to the preceding staff" —
is honored per staff as that pair's minimum, in Verovio units (`"16"` and
`"20vu"` work; `"10mm"` is ignored), and leaves the other pairs alone. Hence
`notation/instrumentSpacing.ts`.

## Verovio `dynamDist` has a dead zone below 2 and never governs `<dir>` or hairpins' stacking (2026-09-04)

Glyph top of a "p" below the bottom line at unit 8, by `dynamDist`: 1 → 40,
2 → 40, 3 → 72, 4 → 152, 6 → 312 user units — i.e. `80·d − 168` once past the
floor, 40 below it (a staff space is 160). `<dir>` text does not move with it
at all (its bbox top even sits ABOVE the staff line, −33, because the text box
carries the ascent), so a `<dir>` under a staff needs its own nudge
(`render/textlayout.ts`).

## Verovio slur side: layer rule in a multi-layer staff, stem rule in a single-layer one (2026-09-04)

With two layers, a layer-1 slur goes ABOVE regardless of the notes' `stem.dir`
(probed both ways on sonata m. 82's material); with one layer it goes opposite
the stems (stems up → slur below, stems down → above). So in a two-voice
passage whose upper voice Verovio stems UP by default, beams, tuplet brackets
and the slur all land above — the "doubly wrong" m. 82. Finale had stems DOWN
there (the lower voice is a stemless whole-note chord), slur above the
noteheads, brackets below; importing `<stem>` as `@stem.dir` reproduces that.
Verovio's layer rule is defensible two-voice engraving (Gould), so no
render-time override was added; `curvedir` can flip a slur but in m. 82 the
flipped side is occupied by the layer-2 chord.

## Tie stubs render as `g.lv`, not `g.tie` (2026-09-04)

Composer's pending-tie stub is an `<lv>`; Verovio's SVG class is `lv`. The
dark-theme fill rule listed `.tie` and `.slur` but not `.lv`, so the stub arc
stayed black on the dark surface. Any class list that enumerates Verovio's
filled shapes needs all three.

## Verovio's autogenerated page header on pages 2+ is "– N –" (2026-09-04)

`header: 'auto'` gives pages 2+ a `g.pgHead.autogenerated` holding
`<text font-size="0px"><tspan class="rend" x=centre y=195 text-anchor="middle">`
with three children: `tspan.text` ("– "), `tspan.num` (which nests a hidden
`<title class="labelAttr">page</title>` before its digit — `textContent`
reads "page2"), and `tspan.text` (" –"). Composer's `styleRunningHeader`
moves the rend's x/anchor to the outer corner and drops the dash tspans; the
number's baseline is untouched so the header band the placement measures
does not move. Read the visible number from `tspan.text` descendants, never
from `textContent`.

## Anything that touches the page header changes placement — record the original ink bottom first (2026-09-04)

`Renderer.headBottomOf` feeds rule v2 (`firstContentTop`, the top-gap origin)
from the live `g.pgHead` bbox. The running-header restyle moved the page number
to a corner and dropped the "–" tspans; the restyled header's bbox bottom read
255 where Verovio's "– 2 –" read 254 (the dash glyph cells sit one unit
differently). One unit in the header bottom shifts the distributed slack, and
the whole-pixel quantization then flipped system 2 on some pages by exactly
10 units — but only on RE-placed pages (a splice re-places the live page,
whose header is restyled) while the reference gate's fresh render kept the
original header and did not move. Presentation: gated sonata sweep, 6 rows,
all "staff top diverged … expected X, live X+10" with identical extents and
identical first tops; 0 on the pre-change tree (stash + rerun of the same
chunks). Fix: `styleRunningHeader` records `data-hkl-head-bottom` (bbox bottom
+ group translate) BEFORE restyling and `headBottomOf` prefers it, so every
host — initial mount, re-placement, reference — measures the same header. Rule
for the future: any injector that edits Verovio's header or anything else
placement reads must leave placement's inputs unchanged, and the gated sweep
(chunks with `check=1`) is the check that finds it; the fixture suite did not.

## A DOM pass that feeds placement must measure in SVG user space, not screen pixels (2026-09-04)

The below-staff text layout first read every rect with getBoundingClientRect
and converted through the system CTM. That is host-DEPENDENT: the live page and
the splice/reference hosts sit at different sub-pixel screen phases, so the
same music produced shifts differing by a fraction of a unit, a `<dir>` nudged
under a system's last staff changed that system's `below` extent by that
fraction, and rule v2's whole-pixel quantization flipped a system by 10 units
on re-placed pages while the reference gate's fresh render did not (gated
sonata sweep: page 4 system 2, page 22 systems 0/1 — extents printed equal to
the unit because the message rounds them). Measured in the SVG's own user
space (`getBBox()` mapped through `getCTM()` to the inner `definition-scale`
viewport, shifts rounded to whole units) the pass is identical on every host.
Same family as the alignStaffRows lesson ("relative, not absolute"): anything
whose output becomes a placement input must not depend on where the render
happens to sit on screen.

**Follow-up (same day)**: after the header-bottom stash and the user-space
text-layout rewrite, three one-pixel divergences remained (page 4 system 2,
page 22 system 1). Instrumenting `measureAndPlace` on both hosts during the
sweep's own edit showed identical extents to three decimals and identical
phase, but the live header bottom at 252.00000763 (its first-pass render,
stashed) against the reference's fresh 254 — the accepted Verovio header
non-determinism of the 2026-09-03 entry, shifting every raw top by two units
so quantization flips one system. Those flips were REJECTED only by float
noise: the reference top came out as 15259.999999999998, so the difference
was 10.000000000002 and the strict `> 10` read it as more than a pixel. The
new layout (dynamics clearance, instrument spacing, restart labels) merely
moved raw tops onto new rounding boundaries. Fix: `TOL = 10 + 1e-6` in the
gate — the tolerance is still one device pixel, the comparison now says so.
Lesson within the lesson: when a gate at an exact-boundary tolerance starts
failing after a layout change, print both sides at full precision before
touching anything else; two of the three "causes" fixed on the way were real
but were not the cause.

## `git stash`/`pop` under a running `pnpm dev` can kill an app's watch on an out-of-root file (2026-09-04)

To baseline the gated sweep on the pre-change tree I stashed the working tree
(`git stash push -u`), ran the sweep, and popped. Afterwards the COMPOSER
Vite server kept serving `packages/notation/src/notation-theme.ts` from
before the pop — the `@fs/…` module had 0 occurrences of the new `.lv` rule
while the file on disk had 2 and the HKL server (:5173) served the fresh copy.
`touch` and a real content change did not invalidate it either: the module is
outside the composer app's root, Vite watches such files individually, and
git's rename-replace gave the file a new inode the old watch no longer sees.
Only a dev-server restart clears it (not mine to do — Max's). The dark
tie-stub fixture therefore fails under the running server although the rule
is on disk and in the build. Lessons: (1) never stash/checkout the live tree
under Max's dev server — baseline a gate BEFORE changing code, or compare on a
copy; (2) when a fixture passes in isolation right after an edit and fails
later with the same code, `curl` the served module and grep for the change
before debugging the code.

## Verovio two-voice engraving rules, probed exactly (2026-09-05)

Bare-toolkit probes on 6.3, chord stems read from `g.chord > g.stem` (a chord's
stem is NOT under `g.note` — the first probe read "none" for every chord):
- **Stems**: with two layers, a slot's stem follows its layer (1 up, 2 down)
  whenever the other layer holds any element WITH A DURATION at that moment —
  note, chord, rest, hidden rest (`visible="false"`) alike; it follows the
  pitch rule only when the other layer holds `<space>`/`<mSpace>` there (the
  source: `Layer::GetDrawingStemDir` → `GetLayerCountForTimeSpanOf(element) <
  2 ? NONE : m_drawingStemDir`).
- **Tuplet bracket**: on the side of the majority stem direction of its notes
  (`Tuplet::CalcDrawingBracketAndNumPos`); `@bracket.place`/`@num.place`
  override it.
- **Slur**: single voice → opposite the stems; two voices → by layer (1 above,
  2 below) regardless of stems; `@curvedir` overrides it.
So in a two-voice staff the upper voice's default slur sits on its own beams
and brackets, and the lower voice's on its own — the m. 82 / m. 84 defect.
Measurement gotcha behind a wrong reading on the way: Verovio nests the beamed
notes INSIDE `g.beam`, so the group's bbox is the notes' (accidentals
included), not the beam polygon's — measure `g.beam > polygon`.

## A Verovio section restart restates the instrument labels — unless a matching `@n` staffGrp replaces them (2026-09-05)

`<section restart="true">` sets `m_drawLabels` and draws the FULL labels
(indenting the system like the first), and `ReplaceDrawingValues` never
touches labels — so a restart scoreDef with `<staffGrp><label/></staffGrp>`
children, bare `<staffDef n>`s, or an empty `<labelAbbr>` in the head all still
labelled (probed in the morning). What the morning probe missed, found in the
6.3.0 source: `ScoreDefSetCurrentFunctor::VisitStaffGrp` calls
`ScoreDef::ReplaceDrawingLabels(staffGrp)` under a restart, which swaps the
drawing label of the head staffGrp with the SAME `@n` (`GetStaffGrp(n)` —
Composer's groups had no `@n`, so the empty label landed on the outer group)
and `View::DrawLabels` returns before `SetDrawingLabelsWidth` for an empty
label. So: `@n` on the head groups + a matching `<staffGrp n><label>ABBR</label>`
gives a restart system that draws exactly what a continuation system draws.
Three traps on the way, each costing a probe:
- the loader rejects a `<staffGrp>` without a `<staffDef>` ("Each <staffGrp>
  must contain at least one <staffDef>", `loadData` returns 0, no log);
- a staffDef with no `@n` or an unused one draws a console warning per render
  (`No @n on <staffDef>` / `StaffDef with xml:id … could not be found`, from
  `ReplaceDrawingValues(const StaffDef*)`), and a staffDef naming a REAL staff
  inside the restart scoreDef puts that staff in `SetCautionaryScoreDefFunctor`'s
  `m_staffNs` — the key courtesy comes back for exactly those staves
  (`SetDrawKeySig(false)` only for staves NOT named);
- `ScoreDef::IsSectionRestart` is "the nearest PRECEDING section milestone has
  `@restart`" (`GetPrevious(this, SECTION)`), so a second scoreDef anywhere
  after the restart start — inside the wrapper or right after it — is a
  restart too, staffNs and all.
The recipe that satisfies all three: restart wrapper holding ONLY the boundary
scoreDef (childless → empty staffNs → no key courtesy anywhere), then a second
plain nested `<section>` holding a second scoreDef with the label staffGrps
whose staffDefs name the group's real first staff (found → no warning, nothing
to replace; not a restart → no courtesy). `m_restart` is cleared only at the
next measure, so the second scoreDef's staffGrps are still visited with it set
and the labels are replaced. Verified: 6.3.0 probes with console capture, the
sonata's three movement boundaries (no courtesy, no labels, continuation
indent, zero Verovio warnings on a full re-render), fixture
`engr_sectionRestartMatchesContinuationSystems`.

## `defaultBottomMargin`, not `defaultTopMargin`, is the cross-staff overflow clearance (2026-09-05)

Verovio widens a staff distance only as far as the colliding boxes plus their
margins. Probed viola-dynamic-below vs piano-high-notes-above at the same x:
`defaultBottomMargin` 0.5/1.0/1.5/2.5 → clearance 39/79/119/199 user units
(80 per unit), the uncollided piano pair fixed at 960 throughout;
`defaultTopMargin` 1.5 alone → no change (only the upper element's bottom
margin counts in that direction). The margin is the one every element without
a dedicated `bottomMargin*` option gets, so it acts everywhere two boxes
collide vertically and nowhere else — the direct lever for "elements that
overflow between instruments", where `staffDef@spacing` (a floor on the LINE
distance) only separated empty staves.

## Verovio erases `bar.thru` barlines under dynamics/dirs/tempi — at draw time only, with no option (2026-09-05)

Sonata m. 89|90: the barline between the piano staves had a hole just below
the upper staff and the piano's "p" sat on the barline further down. Cause:
`View::DrawBarLine` (view_page.cpp) calls
`SystemAligner::FindAllIntersectionPoints(line, box, {CPMARK, DIR, DYNAM,
TEMPO}, unit/2)` for the between-staff stretch of a `bar.thru` barline and
draws the barline as segments around any overlapping mark — skipped for the
bbox device context, so it never touches layout, and none of the 221 options
governs it. Then Composer's text-layout pass moved the mark (centring it in the
grand-staff gap), so the erasure marked where the mark USED to be. Two
consequences: (1) any post-render pass that moves marks must also repair
barlines, and it can — the erased segment leaves a (possibly zero-length)
`M x y L x y` path inside the gap, so the gap is recoverable from the barline's
own `d` attributes without a layout read (`render/barlines.ts`); (2) a dynamic
at tstamp beats+1 is centred exactly ON the barline by Verovio (Finale exports
end-of-measure dynamics like that), which is where the erasure came from in
the first place — the mark now moves inside its own measure first
(`render/textlayout.ts`). Probe technique worth keeping: a whole-document
inventory needs every page mounted — `r.setMountWindowEnabled(false)` then
`r['mountPage'](n)` for each `.score-page-pending` (cb-splice-battery.js);
`ensureMeasureMounted` alone leaves the lazy window to evict pages behind the
cursor, and a per-measure `setCursor` walk ends with only the last page mounted.

## A minimum-variance line partition is globally unstable under one-bar edits (2026-09-05)

The section balancer's first formulation — the DP that minimises Σ(fill−mean)²
over a section at a fixed line count — gives beautifully even fills (sonata
movement sd 0.13 → 0.05) and rewrites the whole section on the smallest edit:
deleting one bar at the end of movement I changed 70 of 35 boundaries, because
the optimum is an interleaving of 3-bar and 4-bar lines and the interleaving
pattern flips when the total shifts by a fraction of a bar. Discreteness, not a
bug. Two additions make it local on the same widths: a change penalty per line
start absent from the current partition (λ = 0.02 — a boundary moves only when
it buys more than λ of variance; 0.005 still rippled), and a merge rule before
the DP (a sparse final line folds into its predecessor while the merged fill
stays ≤ 1.2; at ≤ 1.0 merges never fired and a section under deletion thinned
toward MIN_FILL instead of dropping a line). With both, delete-at-section-end
alternates "pull one bar back" (2 boundaries) and "fold the last line" (1). The
penalty is dropped (λ = 0) only when nothing of the section is mounted — then
the even optimum costs nothing visible. `test/balance/run.mjs` replays this on
the sonata's measured widths.

## Our line fill and Verovio's justification ratio are not the same number (2026-09-05)

`minLastJustification` was set to MIN_FILL (0.65) so a final line is justified
exactly when the owner considers it legal. On a 9-bar document-final section
the balancer produced two lines at 0.80 and 0.657 by OUR fill (naturals sum
over the justified budget) — and Verovio drew the second UNJUSTIFIED, 12710 of
19010, because its ratio (its own justifiable width) came out under 0.65. The
two yardsticks disagree by a few percent both ways (lessons 2026-09-02: ours
runs above on dense lines, below on sparse). One rule expressed in two
measurements needs slack in the direction that keeps the VISIBLE rule true: the
option now sits `LAST_JUSTIFY_SLACK` (0.05) below MIN_FILL, so a line the
balancer kept legal is always drawn justified and a stub it kept (far below by
both yardsticks) is not. Related discreteness fact from the same session: with
~0.27-wide bars (sonata movement IV) only 5 of 215 adjacent pairs form a legal
2-bar line at 0.65, so the DP's freedom is quantised at a third of a line and a
1-bar stub can be genuinely infeasible to absorb — rule 2 (keep the stub) is
reachable in large documents too, not only small ones.

## An idle job that can throw must catch, and a partition-only splice must not mount pages (2026-09-05)

The balance job's first sonata run stalled after movement II: `balanceJobActive()`
stayed true for the whole 120 s wait, movements III/IV were never measured, and
no console notice explained it — an exception inside an idle callback is an
uncaught error, not a `console.error` call, so the probe's console hook saw
nothing. Two fixes, both structural: every job slice runs inside try/catch
(cancel + `console.warn`, rethrow under HKL_INDEX_CHECK) so a throw can never
leave a zombie job holding the partition-cache flag; and the splicer's B5
ensure-mount is skipped for partition-only requests — it had mounted the pages
around movement II's hunk (far from the viewport) and spliced them, which is
where the throw came from and is exactly the work a balance of unmounted lines
must not do. A partition-only hunk whose first line is unmounted is deferred
whole (pins committed, pages stale); only lines the reader can see are spliced.

## A page-first line's target page is its page NUMBER, not where its start measure sits (2026-09-05)

The splicer found the page element for a new page made entirely of hunk lines
by asking where that page's first measure currently sits. Right for every edit
it had seen — a page carried by line keeps its start measure on that page unless
the measure was deleted — and wrong the moment a page-start boundary moves BACK
onto a measure that sits on the previous page: the balancer does that routinely
(a bar or two pulled back at a movement end), and an edit does it when a push
lands on a single-line last page. The line then went to the previous page, the
real page was emptied and removed, and `repairPagination` refused a page whose
systems disagreed with the pins ("spilled systems do not match the pinned
lines") — surfaced by `pageSpliceNewPageAtEnd` only when the idle balance job
happened to finish after the fixture's cascade had created page 4. When a
request keeps the page count, nothing collapses inside the splice, so new page p
IS the element numbered p (`sameGrid` in `spliceDom`); the "measure sits here
now" rule remains for collapses. Timing-dependent failures in a suite are a
gift: this one existed on the edit path before the balancer, unexercised.

## A synthetic measure must have the HEAD scoreDef's staves — label-replacement staffDefs are not staves (2026-09-05)

The splice window's mRest leader/trailer took its staff count from every
`staffDef` in the window MEI. The movement-break restart (sectionRestart.ts,
same day) adds a second scoreDef whose `<staffGrp n><label/><staffDef n/>`
entries replace drawing labels — two more `staffDef`s that are not staves. A
window containing a movement boundary therefore got a 5-staff leader for a
3-staff score, and Verovio's loadData died with `RuntimeError: null function`
(a null staffDef dereferenced through a vtable). The battery's
section-header-zone edit caught it only after the section balancer made its
hunk start exactly at the boundary; the pre-change window shape (one line
earlier, boundary inside) crashes identically when rebuilt by hand, so the bug
was hours old and unexercised. Two lessons: a synthetic element that mirrors
document structure must read that structure from the HEAD definition, never
from a count over the whole document; and a WASM "null function" from Verovio
on load is a malformed-input symptom — bisect the input on a fresh toolkit
(here: strip leader/trailer/pins/stub together, then singly) before suspecting
toolkit state. Fixture: `pageSpliceLeaderAtSectionRestart`.


## 2026-09-05 — Fixture `expr` strings are template literals: backslashes vanish

A regex written inside a `test/composer-test/fixtures.mjs` assertion `expr` (a backtick template) loses its escapes before the browser sees it — `\/` became `//` and commented out the rest of the line (the runner reported "Unexpected token 'const'" on the NEXT line), and `\s` / `\d` become `s` / `d` silently, which is worse: a regex that still parses and matches nothing. Write such regexes without backslashes (`[/]`, `[^]`, `[0-9]`, literal spaces), or build them with `new RegExp` and doubled escapes.

## 2026-09-05 — Anything that walks the live page DOM across an `await` races the mount window

`mountAllPages()` leaves every page mounted, but the next idle tick can run `updateMountWindow` (a pending IntersectionObserver callback schedules it even when its mounts were no-ops) and evict everything beyond two viewports with `innerHTML = ''`. The sonata PDF probe read `pending: 29` right after an export that had collected 31 SVGs. A detached SVG keeps its subtree, so the clones happened to be complete — but the guarantee has to be structural: snapshot (clone) before the first `await`, as `downloadPdf` now does. The same applies to any future export or gate that reads `.score-page` contents asynchronously.

## 2026-09-05 — The text half of the svg-to-pdfkit lesson was never implemented

The 2026-06 entry above ("svg-to-pdfkit ignores Verovio's embedded `<style>`") already named font-style/weight on dir/dynam/tempo as the other thing to inline from computed style — and only the stroke pass was ever written. Verovio's stylesheet is the ONLY source of a tempo's bold (`#<svgid> g.ending, g.fing, g.reh, g.tempo {font-weight:bold}`) and of dir/dynam/mNum italics; the `<tspan>` carries `font-size` alone. Every tempo printed regular for three months; it showed on the sonata heatmap as the brightest spot — two renderings of "Moderato con passione" at different widths — and Max read it as "bold in the app, not in the export" before I did (I had filed it under font metrics). `inlineComputedTextStyle` in save.ts now stamps computed `font-weight`/`font-style` on every text run. Lesson: when a lesson lists N things to do, check that the code does all N — and a heatmap's brightest spot deserves a qualitative read (what differs), not a category (font metrics).

## 2026-09-05 — Composer on its own dev port silently exports PDFs with no accidentals

Every PDF Max exported for months had no accidentals, in Firefox and Chromium alike, while the same code in headless Chromium embedded BravuraText and drew them. The cause was the tab's origin: Composer was open at `localhost:5174/composer/` (its own Vite server) instead of the proxy `localhost:5170/composer/`. Under the proxy, `fetch('/BravuraText.otf')` routes to the HKL server, whose base is `/`, and gets the font; on the composer's own port the app's base is `/composer/`, so its public assets live under `/composer/…` and the root path returns Vite's 404 text. The export never checked the response, PDFKit registered the 404 body as the font, fontkit threw on first use, and svg-to-pdfkit caught that per text run and skipped it — leaving a valid PDF with everything except the BravuraText runs, i.e. every accidental (they are all HEJI-injected `<text>`). The screen looked fine throughout because the `@font-face` for BravuraText falls back to the jsDelivr woff2 when `/BravuraText.woff2` 404s.

Two lessons. (1) The single-origin rule (CLAUDE.md: `pnpm dev` → everything through `localhost:5170`) is not only about BroadcastChannel and IndexedDB: any absolute-path asset an app fetches from another app's public dir depends on it too, and the direct ports keep working well enough to hide the mistake. If a symptom appears in every real browser but not in headless probes against the same server, ask which URL the real tabs are on before anything else. (2) A fetch whose body is handed to a parser must check `ok` (and here the `OTTO` magic); `downloadPdf` now refuses loudly and names the proxy port, and svg-to-pdfkit's warnings go to `console.error` instead of the default `console.warn`.

## Verovio hides a tuplet bracket under one beam only when `@bracket.visible` is unset (2026-09-05)

Probed on 6.3: a tuplet whose children are ONE beam gets its number alone; a
beam over part of the tuplet, a rest outside the beam, or unbeamed notes all
draw the bracket. `bracket.visible="true"` — which Composer wrote on every
tuplet it created, and the importer on every source `bracket="yes"` — forces
the bracket onto the beam. Writing an attribute "for clarity" can override an
engraving default you wanted; omit what you do not mean to decide.

## `dynamDist` is for dynamics only; a lone hairpin hugs the staff (2026-09-05)

Bare-toolkit probe at unit 8: a lone hairpin's top sits 5 px (0.3 space)
below the bottom line at dynamDist 1 AND 4.5; a dynamic's top moves 4 → 19 px.
Verovio aligns a hairpin to a dynamic only when they share a moment (the
hairpin's top then 2 px above the dynamic's) — a crescendo ending at the bar
before an `f` was aligned to something lower, a decrescendo before a `p` not
at all. Also probed: dynamDist does not stack on low notes (a dynamic under a
note below the staff sits at the same y at 1 and 4.5); the note-to-dynamic gap
is `defaultBottomMargin`, the same knob as the inter-instrument clearance.

## Theme tags live on the page wrappers, not only on `#score` (2026-09-05)

`postProcessRendered` runs per mounted page (and per spliced system) and tags
each with `data-notation-theme`; the theme CSS matches any tagged ancestor. A
theme switch that retags only the container leaves every page mounted under
the old theme tagged — and once the inline notehead paint is removed, the
still-live dark rules paint those noteheads white. Anything a per-page pass
sets, the container-level reversal must also reverse per page.

## The scroll-follow anchor is the ACTIVE layer's cursor (2026-09-05)

`visualCursorMeasure()` answered with the voice cursor even in the expression
/ pedal / tempo layers, so every layer action that re-rendered scrolled to the
parked voice cursor — "the scroll jumps to the first page". A virtual layer
with its own cursor needs every cursor-derived anchor (scroll-into-view, page
mounting, the mount window) to ask the layer, not the voice.

## Verovio starts a slur below the OTHER layer's noteheads in its start column (2026-09-05)

A `curvedir="below"` slur on an upper-voice note whose downbeat column also
holds the lower voice's chord is drawn from UNDER that chord — 8 units below
its own notehead in sonata m. 83 — even with a full staff space free between
the voices. Probed on the extracted staff: it follows the chord's noteheads,
not its stem; `slurEndpointFlexibility` 0 still shifts; `@bezier` and `@bulge`
are ignored by 6.3; `@startvo`/`@endvo` are honoured (units, negative = down)
but must be known before the render. When Verovio's routing cannot be steered
by input, redraw the output: the rendered DOM has every box the decision needs
(render/slurlayout.ts). Two probe lessons on the way: a measure number is not
unique across movements (`n="31"` exists in I and III — select by page or id),
and a bounding-box overlap test against a sloped beam polygon flags every
numeral on the page; measure at the polygon's edge under the numeral.

## A pitch-based gate is the wrong tool for a routing problem (2026-09-05)

Verovio's displaced m. 83 slur looked like "no room on the notehead side", so a
gate skipped the flip when the other voice came within N steps. It read the
wrong cause (the endpoint rule, not the space) and, tuned to spare m. 82/84,
still un-flipped every p. 17 bass slur onto its tuplet brackets — the exact
violation the flip exists to prevent. Max: "there is room for it". A
counterfactual render (one attribute removed) attributes a defect; it does not
by itself say WHY the routing failed — probe the variations (remove the chord,
strip its stem, drop it an octave) before choosing a rule.


## A synthetic staff needs the head's staff NUMBERS, not a count (2026-09-05)

Follow-up to the staff-count lesson above: the splice window's mRest leader
built staves `1..n` from the head scoreDef's staffDef count. Under single-part
view the filtered clone keeps a part's own `@n` (the viola alone is staff 3),
so a leader numbered 1 has no staffDef — read the numbers off the staffDefs
and mirror them. Same family as every "reconstruct from the definition" rule:
copy the definition's identifiers, never regenerate them.

## A test edit must be an edit the model accepts (2026-09-05)

`insertRestAtCursor` into a FULL bar is refused (no change, no render), so a
probe that "edits bar 10" of the sonata measured a no-op — `docChanged: false`
is the tell, and every edit probe should report it. Compose past the end
(a new bar) or delete something instead.

## Verovio parks a broken slur's open end at the staff edge (2026-09-05)

A slur across a system break is drawn as two segments (the continuation has
`class="slur id-<id> spanning"` and no id — group by the class token, not by
id, or a DOM inventory reports zero broken slurs). Each open end goes to a
fixed staff-relative spot: for `curvedir="below"` just under the bottom line,
whatever the covered notes do. In the sonata's bass the first segment dived
two spaces to get there and the continuation climbed 5.4 spaces through the
staff and the lower voice. An open end is still an endpoint: anchor it to the
covered notes on that system and route the segment like any slur.

## Three ways a DOM slur re-draw silently gives up (2026-09-05)

Debugging the broken-slur pass on the sonata: (1) the far note of a segment
lives on another page that may not be mounted — resolve within the segment's
own system and require only the near note; (2) ledger lines listed as
obstacles put a slur's own endpoint inside a padded box whenever the note
sits beyond the staff — no bulge can fix an endpoint, so every such slur was
"kept"; (3) anchoring an open end to the extreme covered head anywhere in the
segment, rather than the head nearest the break, started a stub under the
lower voice. Each looked like "the solver found no curve"; a geometry dump of
the segment (path start/end, every glyph box in its x-range, in staff spaces)
found each in one read. Dump before tuning constants.
