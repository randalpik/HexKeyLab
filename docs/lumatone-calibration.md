# Lumatone per-key calibration guide

This guide covers calibrating a Lumatone's keys: running the firmware's built-in routine from HKL, saving and restoring what it stores, setting a key's thresholds **by number** when the learned value isn't right, and shaping the velocity response on top. The numeric part works on the Lumatone's own calibration files over SSH, with the tools in `tools/lumatone-cal/`.

This is a **developer/maintenance** document, separate from the user-facing HKL guide. If you're not the keyboard's owner, don't run any of this — it modifies firmware state on a connected device.

---

## Two ways to set the per-key thresholds

**The built-in routine** learns by touch. SysEx `0x24` (sysexCallibrateKeys) puts every board into calibration, you press every key, and the routine ends when it is confirmed or canceled. Through firmware 1.4.x only a board's own two macro buttons could end it, so a board with broken buttons stayed in calibration until a power cycle. Firmware 1.5.0 adds SysEx `0x52` (ConfirmCalibration), which sends the PICs a software button press (PIC command `0x6a`), and HKL's Calibrate Keys overlay drives the whole routine: **Start key calibration** / **Start aftertouch calibration**, then **Confirm** or **Cancel** (architecture/hkl.md → Built-in calibration). It has been run to completion on a unit with three sets of broken macro buttons (2026-11-11; lessons.md → "The PIC's calibration mode").

**By number**: the routine never shows the values it settles on, and it can't set one key. The values are plain text files on the device, though, so any of them can be read and changed: save the files, edit a number, write them back, power-cycle. Use it when the learned value for a key is off (a weak key that needs a lower trigger point), to set a whole row at once, or to put an earlier calibration back.

Confirming a built-in calibration replaces the per-key numbers (Cancel writes nothing), so **save the files first**.

> **Through firmware 1.4.0** this guide was built around `keydata-live.py`, which wrote thresholds into the running controller's memory so a change took effect within a tick, plus two diagnostic scripts (`lmtncal-read.py`, `lmtncal-poke.py`). They were tied to 1.4.0's binary (its process name and symbol offsets), and existed because the built-in routine could not be finished without macro buttons. With 1.5.0 it can, so they were retired on 2026-11-11 (decisions.md); they remain in git history (`git log -- tools/lumatone-cal/keydata-live.py`). What they could do that the file route can't is change a key without a power cycle.

---

## Lumatone internals (the minimum you need)

The Lumatone is, internally, a **BeagleBone Black running Debian** plus **five PIC microcontrollers** (one per octave board). Communication: UART `/dev/ttyO1`. MIDI to/from host: USB. The Lumatone exposes itself as a USB-ethernet gadget; the BBB has an IP on that interface (`192.168.6.2` for Linux hosts, `192.168.7.2` for Mac/Windows hosts).

The userspace firmware on the BBB is a single ARM ELF binary, `/home/debian/LumatoneController/LumatoneController` (statically linked, non-PIE), launched in an infinite respawn loop by `/home/debian/LumatoneController/lmtn_launcher.sh`. This guide calls it **TC**. The binary is **not stripped** and includes full DWARF debug info, so its functions and data can be found by name.

> **Through firmware 1.4.x** the folder and the program were both `TerpstraController` (a dynamically linked PIE binary). 1.5.0's installer moves the folder, keeping `files/` intact, and leaves `/home/debian/TerpstraController` as a symlink to the new one, so old paths still resolve.

### Per-key state lives in two places

1. **On disk**: `/home/debian/LumatoneController/files/KeyData_1..5`. One file per octave board, plain text, comma-separated. Four rows per file, 56 values per row (one per key):

   | Row | Meaning | Direction | Range |
   |---|---|---|---|
   | 1 | MAX threshold | "abs. distance from MAX ADC to trigger key events" — **HIGHER = stricter** (needs deeper press; if higher than physical ADC swing, key never registers). LOWER = lighter touch triggers. | 0–254 |
   | 2 | MIN threshold | Onset detection — distance from rest before the press-timer starts. Affects velocity-range compression. | 0–254 |
   | 3 | Validity | 0 = key disabled. 1 = key active. | 0/1 |
   | 4 | AT MAX threshold | Aftertouch trigger band. | 0–254 |

   These are loaded when TC starts (`loadKeySetting`/`loadKeyThresholds`) and pushed to the PICs over UART as part of bootSequence. A confirmed built-in calibration rewrites rows 1, 2 and 4.

   **What the built-in routine puts in rows 1 and 2** (read from the 1.5.0 PIC image; lessons.md → "The PIC's calibration mode"): MAX is the highest sensor reading the key reached at any moment of the routine, and MIN is its rest reading when the routine started. In play, the press timer starts at MIN plus the board's `min lo` and the note-on fires above MAX minus the board's `max` (`ThresholdData_N` rows 4 and 1), so a key's timing window is MAX − MIN − (`max` + `min lo`) sensor counts. Two things follow. A key squeezed harder during the routine than it is in normal play gets a note-on point that normal play reaches late, or never. And the overhead is the same number of counts for every key, so a key with a small swing keeps a small window and reads loud.

2. **In running memory**: the `boardId[5]` array in TC's `.bss` (`board_properties`, 638 bytes per board; same layout in 1.4.0 and 1.5.0, different address). Earlier notes called it `kbd_preset_params`, which is really a 5-byte flags struct. Same four rows at offsets `+0x118`, `+0x150`, `+0x1c0`, `+0x1fe` relative to that board's slot. Slot `i` (0..4) corresponds to `KeyData_(i+1)`. Editing a file does not touch this copy: the new values load when TC next starts.

The per-board thresholds and sensitivities (the sliders in Calibrate Keys) are a separate layer, stored in `files/ThresholdData_1..5`: ten rows of one value each.

### Indexing quirk: spatial vs PIC

The files and the in-memory struct are laid out by **PIC/SysEx board number** (1..5), not by spatial position. On some units boards 3 and 4 are *physically* swapped — what looks like spatial board 4 actually wires to PIC 5, and spatial board 5 wires to PIC 4. In HKL this swap is the **Swap boards 3 ↔ 4** toggle (`swapBoards34`), which selects the `[1, 2, 3, 5, 4]` board mapping instead of the standard `[1, 2, 3, 4, 5]` — mapping HKL's spatial group index 0..4 to SysEx board ID 1..5. `keydata-locate.py` is independent of the app and uses the standard map by default; on a swapped unit, add **`--swap-boards-34`** to every command (the same flag as `tools/lumatone-bench`).

For a key at HKL coords (q, r):
- Find spatial `board_group = baseKeys_index // 56`
- `sysex_board = SYSEX_BOARD_MAP[board_group]` (`[1,2,3,4,5]`, or `[1,2,3,5,4]` with `--swap-boards-34`)
- File name = `KeyData_{sysex_board}`; the key's value is slot `baseKeys_index % 56` of each row (0-indexed)

`keydata-locate.py` does all of this; just pass (q, r) from HKL's coords display.

### Direction reality check

The PIC's sensor reading is **low at rest and rises as the key is pressed** (read from the PIC's calibration routine, and visible in the key diagnostic display; earlier versions of this guide had it the other way round). The note-on fires once the reading exceeds MAX minus the board's `max` threshold, so MAX sets how deep the press must go. A high MAX value means the key has to travel a long way — if its physical sensor swing is small (weak magnet, alignment drift), it can't reach the threshold and appears dead. Lowering MAX makes the key responsive at lighter touches.

Velocity is computed as `time(MAX crossing) - time(MIN crossing)`. The **gap** between MIN and MAX thresholds is the resolution budget for press-time measurement. Smaller gap = press-time always short = velocities skew high (compressed). Wider gap = more dynamic range, but only if the sensor can swing that far.

**MIN and MAX move velocity in opposite directions:**

| Knob | Effect on press_time | Effect on reported velocity |
|---|---|---|
| Raise MIN | shorter (timer starts later) | velocity **higher** |
| Raise MAX | longer (timer ends later) | velocity **lower** |

Practical use:
- **Onset issue (key won't register on light press)**: MAX is too high relative to the key's physical ADC swing. *Lower MAX* until it registers.
- **Saturated high (every strike reads >100)**: MIN→MAX gap is too small for press-time to discriminate forces. *Raise MAX* to widen the gap.
- **Stuck middle (can't reach 127 at fff)**: gap is wide enough but press-time floor is hit. *Raise MIN* to narrow it from below.
- **Per-key MIN and MAX are 8-bit** (0..254), not the 4-bit clamp that the per-board SysEx (0x29/0x2A) suffers from on this firmware. Don't confuse the two layers.

---

## Access

Nothing is installed on the device; the tools run on the host. You'll need SSH access to the Lumatone (the USB-network connection is active whenever it is plugged in) and local Python 3.

```bash
# Confirm you can reach the device. On Linux:
ping -c 1 192.168.6.2          # (on Mac/Windows: 192.168.7.2)

# Confirm SSH access. Password: temppwd
ssh debian@192.168.6.2 'echo ok'
```

`keydata-backup.sh` logs in for you: it reads the address from `LUMATONE_HOST` (default `192.168.6.2`) and the password from `LUMATONE_PASSWORD` (default: the stock one).

---

## The tools

All in `tools/lumatone-cal/` unless noted.

### `keydata-backup.sh` (run locally; talks to the Lumatone over SSH)

```bash
tools/lumatone-cal/keydata-backup.sh save [dir]      # copy KeyData_1..5 + ThresholdData_1..5 off the device
tools/lumatone-cal/keydata-backup.sh verify <dir>    # compare the device with a saved folder (read-only)
tools/lumatone-cal/keydata-backup.sh check <dir>     # is a folder well formed? (no device needed)
tools/lumatone-cal/keydata-backup.sh restore <dir> [--thresholds]
```

- `save` writes to `tools/lumatone-cal/backups/keydata-<date>-<time>` unless given a folder, with a `SHA256SUMS`, and confirms the copy matches the device. `backups/` is gitignored: saved copies stay in the repo folder and out of the repo.
- `check` refuses anything that isn't four rows of 56 integers from 0 to 254 per `KeyData` file (and ten single-value rows per `ThresholdData` file, when the folder has them). Run it after a hand edit: a dropped or doubled value shifts every key after it.
- `restore` runs the same check, saves what the device holds now to `tools/lumatone-cal/backups/before-restore-<date>-<time>` (so it can be undone), copies `KeyData_1..5` over the device's files (and `ThresholdData_1..5` with `--thresholds`), runs `sync` on the device, and verifies by checksum. Then **power-cycle the Lumatone** (or `sudo reboot` over SSH): TC reads these files only when it starts.

`<dir>` is any folder holding those files: one made by `save`, or the `files/` folder of a full device backup. Works on any firmware.

### `keydata-locate.py` (run locally)

Given a lattice (q, r), prints which file and which slot hold that key's values, and the values themselves.

```bash
python3 tools/lumatone-cal/keydata-locate.py [--swap-boards-34] <q> <r> <dir>
```

`<dir>` is the same kind of folder `keydata-backup.sh` takes. Its key table is a copy of `apps/hkl/src/layout/baseKeys.ts`.

### `keydata-compare.py` (run locally)

Compares saved folders, one per confirmed run of the built-in calibration, without touching the device.

```bash
python3 tools/lumatone-cal/keydata-compare.py [--swap-boards-34] [--top N] [--level L] [--write DIR] [--maps DIR] [--scales FILE] <run-dir> [<run-dir> ...]
```

A run stores one number per key (the deepest reading it saw), so the only way to tell a key's real swing from one unusual press is to repeat the run. Give the folders in the order they were saved. The report has:

- **Runs**: each folder's MAX and MIN ranges, and the board's `max` + `min lo` overhead read from its `ThresholdData`.
- **Repeatability** (two or more runs): each run's overall level (its mean MAX), the per-key spread of MAX as stored and with the run levels removed, the run-to-run spread against the spread between keys, how each pair of runs correlates, and the least repeatable keys with their value in every run. A whole run can sit several counts above or below another while the key-to-key pattern stays the same, so the level-removed figures are the ones that say whether the pattern is repeatable; `--write`'s plain median then mostly follows the middle run, and says so.
- **Timing window**: MAX − MIN − (`max` + `min lo`) from the per-key medians, smallest first. A shorter window reads louder at the same touch.
- **Siblings**: each key's window against the median of the same slot on the other four boards, in both directions. Slot position explains about half of the variation in MAX, so a key far from its siblings is a better suspect than a key that is merely low.

`--write DIR` writes a folder whose MAX and MIN rows are the per-key medians (validity, AT MAX and `ThresholdData` come from the last run), ready for `keydata-backup.sh check` and `restore`. `--level L` separates the two things a run measures: it takes the key-to-key pattern from every run, with each run's level removed, and places the median at a level you choose, given as run labels (`R3,R4`: the mean of those runs' levels) or as a number (a mean MAX). Pressing more firmly raises a run's level and, with it, every key's note-on depth and timing window by the same count, so the level is a choice and the pattern is the measurement. With `--level`, the windows, the sibling comparison and the maps describe what `--write` would store. `--maps DIR` draws `window.png`, `siblings.png` and, with two or more runs, `spread.png`: the keyboard as HKL's Lumatone rotation shows it, each key labeled with its value and (q, r). Maps need matplotlib; keep them in a folder under `tools/lumatone-cal/backups/`. `--scales FILE` writes HKL's per-key press-time scales (workflow step 6): for each key the median window over its own, from the same values `--write` would store, as JSON; it never overwrites a file, leaves out a key with no timing window, and holds a scale to 0.1–10.

### `KeyData_default`

A uniform baseline (MAX=70 / MIN=0 / valid=1 / AT_MAX=200) for a board that has no usable calibration; see "Seeding a baseline" below.

### `pic18dis.py` (run locally)

A minimal PIC18 disassembler for the octave-board image (`LMTN-01_OctaveBoard*.hex`): `python3 tools/lumatone-cal/pic18dis.py image.hex > out.asm`. Firmware reading only; it is how the calibration routine in lessons.md was traced.

### `tools/reset-calibration.sh` (run locally)

Sends the SysEx factory resets for the velocity, aftertouch and Lumatouch tables and the per-board thresholds. It does not touch the per-key `KeyData` files.

---

## Workflow: full-keyboard calibration

Calibrate with the built-in routine, look at what the keys report, set the velocity response (one-tick tables on the device, the curve in HKL), adjust single keys by number where the learned value isn't right, and even the keys out with HKL's per-key press-time scales.

### 1 — Save what the device holds

```bash
tools/lumatone-cal/keydata-backup.sh save
```

### 2 — Built-in key calibration (from HKL, firmware 1.5.0+)

1. Open **Calibrate Keys** in HKL (Lumatone tab, or `Shift+\`). Under **Built-in calibration**, click **Start key calibration**.
2. Press every key all the way down. Don't rush: the routine marks a key learned only once it has seen it pressed.
3. Click **Confirm (save)**. HKL waits for every board to leave calibration, then re-reads the board values. **Cancel (discard)** leaves the files as they were.
4. Save again (`keydata-backup.sh save`) so the result has its own snapshot.

One run is one sample per key: the routine keeps the deepest reading it saw, so a key squeezed harder or lighter than usual gets a value that is off. To check a calibration, or to build one from several, repeat steps 2–4 and compare the saved folders with `keydata-compare.py`; its `--write` makes the per-key median, which goes back with `keydata-backup.sh restore`. Press each key once, firmly, the way it bottoms out in normal play, and keep hands off the keys when starting: the rest reading is taken at that moment.

During calibration a board's own macro buttons still act on that board alone: pressed and released, one saves and the other discards. Holding one while pressing a key opens that board's key diagnostic display instead (each key colored by its raw sensor reading), which only pressing both of its buttons leaves (lessons.md → "The PIC's calibration mode").

A confirmed key calibration also resets every key's **AT MAX to 254**, so an aftertouch calibration (**Start aftertouch calibration**) has to come after it. To keep an earlier AT MAX row instead, put it back by number (step 5).

On the one unit measured (2026-11-11) the routine landed on MAX 36–101 (median 72) and MIN 0–8, and the five keys previously lowered by ear came back among its seven weakest.

### 3 — Collect velocity statistics

1. Connect with Auto-sync on: HKL then sends the identity LUT and the interval table itself (step 4), so the raw velocities are press times (velocity = 128 − ticks on the one-tick table).
2. Enable "Collect" in the **Per-key velocity statistics** section.
3. Play every key 30-50 times across the full range of forces you'd use in normal play. The scatter populates with each key's (p5, p95) point. Two clusters typically emerge:
   - **Top-right cluster**: p5 >> 30, p95 close to 127. Keys saturate high — soft presses still register as forte.
   - **Diagonal-middle cluster**: p5 around 50-80, p95 around 80-100. Keys stuck in the middle of the velocity range.

### 4 — Velocity shaping: one-tick tables on the device, the curve in HKL

The device reports a press as a velocity through two tables, and HKL sets both so that the velocity is the press time and nothing else (rewritten 2026-11-22; the earlier recipe, with `low` = 3 and an audio gamma of 13.9, rested on tick figures that were computed rather than measured and on tables the device was not running; decisions.md, lessons.md):

| Setting | Value | What it does |
|---|---|---|
| CMD 0x08 LUT | identity (slowest bin sent as 1) | velocity = 127 − bin. Sent by HKL with every connect. |
| CMD 0x20 intervals: `low` | **1** | the fastest bin is a press of one tick or less, which every key can produce (Max, 2026-11-22) |
| CMD 0x20 intervals: `high` | **127** (`low` + 126) | thresholds 1…127, one tick per velocity: velocity = 128 − ticks. `low` + 127 skips one threshold (64 and 65 ticks share a bin); a narrower span repeats thresholds and merges nothing useful. |
| CMD 0x20 intervals: `gamma` | **1.0** | linear; anything else gives up the one-tick-per-velocity reading |
| Lumatone velocity curve: `full at` | **125.6** to taste | the input velocity at which a press reaches full loudness; the one constant that places the scale |
| Lumatone velocity curve: `gamma` | **1.00** | the piano; raise or lower it only to widen or narrow the dynamic range |

**The curve** (Calibrate Keys → Lumatone velocity curve) is the piano's own law in the device's units. On a piano the peak amplitude of a tone is linearly proportional to the hammer's velocity (Palmer & Brown, "Investigations in the amplitude of sounded piano tones", JASA 1991); on the Lumatone the speed of a press is 1 ÷ its press time. So, with the press time taken after the key's own scale (step 6):

`gain = (full's press time ÷ ticks)^gamma`, never above 1

There is no floor: a slower press is quieter without limit, and what plays is bounded below by the house curve's quietest note (musical velocity 1, −25.9 dB). At gamma 1 every doubling of press time costs 6 dB.

**Input velocity** is the unit the curve is tuned in and the number the Diagnostics overlay shows: the hardware velocity after the key's scale, 128 − ticks on the one-tick table. The graph plots the curve against it. With the defaults:

| Input velocity | 126–127 | 125 | 123 | 120 | 115 | 105 | 95 | 80 |
|---|---|---|---|---|---|---|---|---|
| Press time (ticks) | 1–2 | 3 | 5 | 8 | 13 | 23 | 33 | 48 |
| Level | full | −1.9 dB | −6.4 dB | −10.5 dB | −14.7 dB | −19.6 dB | −22.8 dB | −26.0 dB |

`full at` 125.6 was chosen on one unit (Max's, 2026-11-22, `min lo` 3) so that the softest press he can play consistently, just under input velocity 80, lands on the quietest note; his comfortable soft sits at 105 and his comfortable loud at 123. To set it on another unit: play your softest consistent press, read its input velocity off the overlay, and move `full at` until that velocity is where the graph meets the bottom. A lower `full at` makes everything louder and full loudness easier to reach.

What comes *out* of the curve is the **musical velocity** the note sounds at: the curve's gain re-expressed on the gentle house curve (floor 0.05, gamma 1.5) that every instrument and Piano output share. The overlay does not show it.

**Reading a key's input velocity and ticks**: enable the Diagnostics overlay (the **Diagnostics** checkbox on HKL's Playback tab, with Audio on) and play. Each velocity peak is labeled `vN (Mt)` as above.

**Tuning by ear from this baseline:**
- *Everything too quiet or too loud for the same touch, or full loudness too hard or too easy to reach:* `full at`.
- *The range from soft to loud too narrow or too wide:* gamma, away from 1. This leaves the piano's law.
- *One key louder or softer than its neighbors at the same touch:* not the curve; step 6.
- *Two samples sound different at the same velocity:* sample-side; not addressable from the curve.

**Future piano-realism factors** (filed; not gain-curve work): velocity → low-pass cutoff (for hammer-brightness simulation), velocity → attack-time modulation, soft-clipping at extreme-high velocities. See `docs/decisions.md` → "Future piano-realism factors."

**Persistence**: CMD 0x20 and CMD 0x08 change the controller's RAM only. CMD `0x09` (SaveVelocityConfig), or `0x02` (StoreProgram, which saves a whole preset), writes **both** tables, with fsync, to a preset slot's `files/VelocityLookUp_N` (one file per slot 0–9; line 1 = the 128-entry 0x08 LUT, line 2 = the 127-entry 0x20 intervals). Read from the firmware, same in 1.4.0 and 1.5.0. HKL never sends 0x09, so a power cycle or preset change reloads whatever the preset file holds. Since 2026-11-22 HKL therefore sends both tables itself, with the rest of its connect-time setup and again after a preset switch (architecture/hkl.md → Velocity tables), so the device runs the identity LUT and your interval curve whenever HKL is connected with Auto-sync on; the two buttons send them again on demand, which is what a slider change needs. Before that date they were sent only by the buttons, and a unit that was power-cycled ran its preset's tables under HKL's curve (lessons.md → "The device ran its preset's velocity tables"). A preset button held for 3 s (StoreProgram) saves the live tables into that slot.

### 5 — Adjust keys by number

For a key the routine got wrong, or a whole row you want set:

```bash
# 1. Start from what the device holds.
D=tools/lumatone-cal/backups/edit
tools/lumatone-cal/keydata-backup.sh save $D

# 2. Find the key. (q, r) from HKL's coords display; add --swap-boards-34 on a swapped unit.
python3 tools/lumatone-cal/keydata-locate.py <q> <r> $D
#    → "KeyData file: KeyData_N", "Comma slot (0-indexed): S", and the four current values

# 3. Edit that slot of the row you want in $D/KeyData_N
#    (row 1 = MAX, 2 = MIN, 3 = validity, 4 = AT MAX), then check the folder.
tools/lumatone-cal/keydata-backup.sh check $D

# 4. Write it back, then power-cycle the Lumatone.
tools/lumatone-cal/keydata-backup.sh restore $D
```

What to change, from the direction table above:

- **A key that won't register, or only on a hard press**: lower its MAX.
- **A key still in the "Can't play loud" list** (p95 < 100): raise its MIN — try 10, 20, 30. This narrows the press-time window, pushing reported velocities upward. Stop when p95 saturates or p5 creeps back up.
- **A whole row**: replace the row in each of the five files, e.g. row 4 with 56 × `200` to put AT MAX back to the project baseline after a key calibration reset it to 254.

Each round costs a power cycle, so collect the keys to change (step 3's outlier lists) and edit them in one pass.

**Raising MAX across the board** to widen the velocity range is a hardware lever that works on some units and not on others: keys with a small sensor swing go dead as MAX passes it, and have to be rescued one by one. It was an iterative, live procedure with the retired `keydata-live.py` (lessons.md → "Per-key calibration converges in 3-4 passes of bulk-raise + per-key rescue"); with files it is one power cycle per pass. On a unit whose swing distribution is tight it doesn't pay off at all, and step 4's interval table is the lever that works on every unit (lessons.md → "Hardware MAX is not a reliable dynamic-range lever for narrow-ADC-swing keyboards"; decisions.md → "Velocity shaping: software input curve over hardware MAX raising").

**Remaining range gaps** (keys whose loudness still differs from their neighbors' at the same touch) are step 6's job.

### 6 — Even the keys out: per-key press-time scales

For the same touch a key's press time follows its timing window, MAX − MIN − (`max` + `min lo`) sensor counts (lessons.md → "Press time follows the timing window"), and the windows of one calibration differ by a factor of several. HKL corrects that with one number per key that multiplies the key's press time before the velocity curve (architecture/engine.md → Velocity architecture). The numbers come from the calibration files, with no pressing:

```bash
# The folder must hold what the device runs: verify it first.
tools/lumatone-cal/keydata-backup.sh verify <dir>
python3 tools/lumatone-cal/keydata-compare.py [--swap-boards-34] --scales tools/lumatone-cal/backups/key-scales-<name>.json <dir>
```

Then, in HKL's Calibrate Keys, **Per-key press-time scale → Import key scales…** and choose the file. Each key's scale is the median window over its own window, so a median key keeps its feel and the curve's gamma stays the one sensitivity knob. Do it again after every confirmed calibration or `restore`: the scales describe one set of `KeyData` files. `--swap-boards-34` matters here, since the file names keys the way HKL does (board group 1–5, key 0–55).

To correct single keys by touch instead, use the capture in the same section: **Start capture**, press the keys at the touch you intend for the target velocity, **Stop & compute**. Each pressed key's scale becomes the target's press time over the key's median press time; keys not pressed keep theirs.

Two limits. A narrow key has few ticks, so after scaling its velocities come in steps of its scale, and its fastest press (one tick) tops out below 127. And the rule was fitted on three keys (2026-11-22): the two ordinary ones landed together, the narrowest was over-corrected by about 40%.

### Seeding a baseline

For a board with no usable calibration (and no way to run the built-in routine on it), seed it and work from there by number. In a saved folder, overwrite that board's file with `KeyData_default`, or with a calibrated board's file, then restore:

```bash
D=tools/lumatone-cal/backups/seed
tools/lumatone-cal/keydata-backup.sh save $D
cp tools/lumatone-cal/KeyData_default $D/KeyData_1        # the uniform baseline, or:
cp $D/KeyData_2 $D/KeyData_1                              # board 2's values as board 1's start
tools/lumatone-cal/keydata-backup.sh restore $D           # then power-cycle
```

Another board's values are not optimal (sensor variance differs between boards) but a better starting point than unknown ones.

---

## Recovery and safety

### Undo a restore, or a calibration

Every `restore` first saves the device's files to `tools/lumatone-cal/backups/before-restore-<date>-<time>`; restoring that folder puts them back. To undo a confirmed built-in calibration, restore the folder you saved before it (workflow step 1). Power-cycle after either.

### Check what the device holds

`keydata-backup.sh verify <dir>` compares the device with any saved folder without writing anything.

### TC crashed / device unresponsive

The launcher script (`lmtn_launcher.sh`) ends in `while :; do sudo <controller>; done` (`LumatoneController` from 1.5.0; `TerpstraController` before, or if an older package was reinstalled). If TC dies, it restarts automatically. No on-disk state is damaged by a TC crash. Power-cycle (unplug, wait 5 seconds, replug) if anything looks weird — that's a clean reset, **provided nothing was written to the device just before**: after a `cp` or an upload, run `sync` (or `sudo reboot`) first, or the new file can come back zero-filled (lessons.md, 2026-11-08). `keydata-backup.sh restore` runs `sync` itself before it reports done.

### Lumatone factory reset

Beyond what's in this guide, the Lumatone supports a full factory reset via SysEx commands `0x0A` (velocity LUT), `0x12` (AT LUT), `0x2F` (Lumatouch LUT), `0x34` per board (per-board thresholds), `0x46` (preset slots), and the helper `tools/reset-calibration.sh` bundles several of these. None of those touch the per-key KeyData files; only a confirmed built-in calibration or a file restore does.

---

## What's deliberately NOT here

- **Live per-key edits.** A file edit takes a power cycle to load. Writing the running controller's memory (what the retired `keydata-live.py` did on 1.4.0) avoids that, but ties a tool to one firmware build's addresses. If live tuning is needed again, start from that script in git history and re-derive every address from the installed binary; never just rename the process it looks for.
- **A way to set per-key thresholds over MIDI.** That would require running a daemon on the BBB that translates SysEx → file or memory writes. Numeric edits need SSH; the built-in routine and everyday play don't.
- **A GUI in HKL for per-key threshold editing.** HKL handles the software side, the per-key press-time scale and the velocity curves (see `apps/hkl/src/audio/velocityCal.ts`), which is enough for normal use. Direct hardware-side edits are rare enough to live in CLI tools.
- **A per-key sensor readout.** Firmware SysEx `0x35` streams one key's raw sensor reading, but no tool is built on it (lessons.md → "The PIC's calibration mode").

---

## Caveats and known limits

- The 4-bit clamp on per-board SysEx commands (`0x29`/`0x2A` for max/min thresholds) does NOT apply to the per-key values in `KeyData_N` — those are 8-bit (0–254). Don't confuse the two; Calibrate Keys' sliders work with the 4-bit per-board values, the files with the 8-bit per-key ones.
- The PIC firmware has no per-key velocity LUT or per-key gain knob. Beyond MIN/MAX threshold tuning, per-key loudness differences are corrected in HKL by the per-key press-time scale in `velocityCal.ts` (workflow step 6).
- Sensor swing is a physical floor. A key whose ADC barely moves on full press will never have the dynamic range of a healthy key, no matter how the thresholds are tuned. The combination of (a) compressed-but-functional hardware thresholds, plus (b) HKL's per-key press-time scale to even the keys out, is the realistic ceiling.
- `lmtn_launcher.sh`'s firmware-update hook runs only when a `Lumatone-v*.tgz` file is found at `/home/debian/` at boot, and the installer leaves `files/` alone (the 1.5.0 install kept every file byte-identical). Every boot also deletes any other `.tgz` in `/home/debian`, so don't keep backups there as tarballs. A package that fails to unpack is deleted and the application still starts under the 1.5.0 launcher; the 1.4.0 launcher aborted instead, leaving the boards frozen in their boot animation on every boot until the package was removed (lessons.md, 2026-11-08).
