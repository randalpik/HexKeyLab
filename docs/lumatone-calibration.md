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

The PIC's sensor reading is **low at rest and rises as the key is pressed** (read from the PIC's calibration routine, and visible in the key diagnostic display; earlier versions of this guide had it the other way round). So MAX threshold = "how far the reading must rise from rest before triggering." A high MAX value means the key has to travel a long way — if its physical sensor swing is small (weak magnet, alignment drift), it can't reach the threshold and appears dead. Lowering MAX makes the key responsive at lighter touches.

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

### `KeyData_default`

A uniform baseline (MAX=70 / MIN=0 / valid=1 / AT_MAX=200) for a board that has no usable calibration; see "Seeding a baseline" below.

### `pic18dis.py` (run locally)

A minimal PIC18 disassembler for the octave-board image (`LMTN-01_OctaveBoard*.hex`): `python3 tools/lumatone-cal/pic18dis.py image.hex > out.asm`. Firmware reading only; it is how the calibration routine in lessons.md was traced.

### `tools/reset-calibration.sh` (run locally)

Sends the SysEx factory resets for the velocity, aftertouch and Lumatouch tables and the per-board thresholds. It does not touch the per-key `KeyData` files.

---

## Workflow: full-keyboard calibration

Calibrate with the built-in routine, look at what the keys report, shape the velocity response in the firmware's interval table and HKL's curve, and adjust single keys by number where the learned value isn't right.

### 1 — Save what the device holds

```bash
tools/lumatone-cal/keydata-backup.sh save
```

### 2 — Built-in key calibration (from HKL, firmware 1.5.0+)

1. Open **Calibrate Keys** in HKL (Lumatone tab, or `Shift+\`). Under **Built-in calibration**, click **Start key calibration**.
2. Press every key all the way down. Don't rush: the routine marks a key learned only once it has seen it pressed.
3. Click **Confirm (save)**. HKL waits for every board to leave calibration, then re-reads the board values. **Cancel (discard)** leaves the files as they were.
4. Save again (`keydata-backup.sh save`) so the result has its own snapshot.

During calibration a board's own macro buttons still act on that board alone: pressed and released, one saves and the other discards. Holding one while pressing a key opens that board's key diagnostic display instead (each key colored by its raw sensor reading), which only pressing both of its buttons leaves (lessons.md → "The PIC's calibration mode").

A confirmed key calibration also resets every key's **AT MAX to 254**, so an aftertouch calibration (**Start aftertouch calibration**) has to come after it. To keep an earlier AT MAX row instead, put it back by number (step 5).

On the one unit measured (2026-11-11) the routine landed on MAX 36–101 (median 72) and MIN 0–8, and the five keys previously lowered by ear came back among its seven weakest.

### 3 — Collect velocity statistics

1. **Push identity LUT** from Calibrate Keys (Hardware foundation → "Push identity LUT to Lumatone"). Makes the firmware emit its full 0-127 range.
2. Enable "Collect" in the **Per-key velocity statistics** section.
3. Play every key 30-50 times across the full range of forces you'd use in normal play. The scatter populates with each key's (p5, p95) point. Two clusters typically emerge:
   - **Top-right cluster**: p5 >> 30, p95 close to 127. Keys saturate high — soft presses still register as forte.
   - **Diagonal-middle cluster**: p5 around 50-80, p95 around 80-100. Keys stuck in the middle of the velocity range.

### 4 — Velocity shaping: the firmware interval table (CMD 0x20)

**The empirical recipe** (validated 2026-05-18 on one unit; see `docs/decisions.md` → "Velocity calibration final form"):

| Parameter | Value | What it does |
|---|---|---|
| `intervalCurve.low` | your fastest reliable press time (ticks), e.g. 3 | lower boundary of bin 0 |
| `intervalCurve.high` | **`low + 127`** (e.g. 130) | upper boundary; this width ensures the 127-entry table spans 128 distinct integer thresholds → no duplicates → no irregular reachable-bin pattern |
| `intervalCurve.gamma` | **1.0** | linear distribution; the only sensible value given the high choice |
| audio-stage `gamma` | **13.9** | empirical optimum to map your natural press range to the full ~30 dB audio range with smoothest dB-per-tick taper |
| audio-stage `floor` | **0.03** | 30 dB curve range (digital-piano convention) |
| audio-stage `ceiling` | 1.00 | unchanged |
| CMD 0x08 LUT | **identity-from-1** (push via "Push identity LUT to Lumatone" button) | maps bin → MIDI velocity 1..127 (clamped from 0 so the slowest press doesn't emit note-off-semantic vel=0) |

**Step-by-step:**

1. Open Calibrate Keys. Find the **Hardware velocity intervals (CMD 0x20)** subsection.
2. Enable the Diagnostics overlay (the **Diagnostics** checkbox on HKL's Playback tab, with Audio on) and turn on **Key data**. Play your fastest possible press several times across the keyboard. The orange velocity-event labels show `vN (Mt)` — note the *smallest* tick value (M) you can reliably produce. That's your `low`.
3. Set `high = low + 127`. This makes the 127-entry table hold 128 distinct integer thresholds (low, low+1, ..., low+127), so binary_search exact-matches at a unique table index for every tick the keyboard can produce. Your natural press-time range (low..~50 for a typical keyboard) maps to bin indices ≈ 0..47, which under identity 0x08 LUT becomes MIDI vel 127..80 — i.e., your full play range lives in the upper half of MIDI velocity space.
4. Set `gamma = 1.0`. (γ_int just changes the distribution of bin indices across the table; it doesn't change the reachable count. Linear is the simplest mental model under high = low + 127.)
5. Click **Push to Lumatone (CMD 0x20)**.
6. Above, click **Push identity LUT to Lumatone (CMD 0x08)** — this loads the "identity-from-1" mapping (bin 127 → vel 1 instead of vel 0).
7. In the **Lumatone velocity curve** subsection: set `floor=0.03`, `ceiling=1.00`, `gamma=13.9`. (The curve's gamma slider goes up to 20; high γ values like this only make sense once CMD 0x20 high is widened to cover the full 127-bin table as in step 3.)
8. Play across the dynamic range. The "Distinct velocities observed" counter in the Calibrate Keys velocity panel should converge to ~48–49 (one per integer tick in your physical range plus the two open-ended boundary bins).

**Tuning by ear from this baseline:**
- *Loud end feels twitchy:* lower audio `gamma` (13.9 → 12 → 11 → 10). Gives up 1–2 dB of total range but the loud-end per-tick step shrinks from ~0.94 dB to ~0.70 dB. γ=10 is the sweet spot for "uniform stepping across the whole range" if you don't mind giving up 2 dB.
- *Bottom feels too quiet for the room:* raise audio `floor` (0.03 → 0.05 → 0.07). Trades curve range for soft-end audibility.
- *Per-note loudness inconsistency:* use **Per-key auto-capture** in Calibrate Keys (per-key gain) — this is a per-key variance issue, not a global-curve issue.
- *Two samples sound different at the same velocity:* sample-side concern; not addressable from the gain curve.

**Per-tick dB steps under the recipe** (high=130, γ_audio=13.9): ~0.94 dB/tick at the loud end (T=3..15), tapering smoothly to ~0.1 dB/tick near the floor (T=45..50). This is intrinsic to power-law audio curves over a wide dynamic range — pianos have a similar shape (wide differentiation at loud dynamics, compression near floor).

**Future piano-realism factors** (filed; not gain-curve work): velocity → low-pass cutoff (for hammer-brightness simulation), velocity → attack-time modulation, soft-clipping at extreme-high velocities. See `docs/decisions.md` → "Future piano-realism factors."

**Persistence**: CMD 0x20 and CMD 0x08 change the controller's RAM only. CMD `0x09` (SaveVelocityConfig), or `0x02` (StoreProgram, which saves a whole preset), writes **both** tables, with fsync, to a preset slot's `files/VelocityLookUp_N` (one file per slot 0–9; line 1 = the 128-entry 0x08 LUT, line 2 = the 127-entry 0x20 intervals). Read from the firmware, same in 1.4.0 and 1.5.0. HKL never sends 0x09, so a power cycle or preset change reloads whatever was last saved: click both **Push to Lumatone** buttons again (`localStorage` keeps your curve parameters, so that's two clicks).

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

**Remaining range gaps** (a few outlier keys whose loudness still drifts after global shaping): use HKL's per-key gain + audio-stage curve in Calibrate Keys' "Lumatone velocity curve" section. The per-key gain adjusts per-key loudness offset; the curve's `gamma` parameter compresses the low end further in audio gain space.

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
- **A GUI in HKL for per-key threshold editing.** HKL handles software-side per-key gain and velocity curves (see `apps/hkl/src/audio/velocityCal.ts`), which is enough for normal use. Direct hardware-side edits are rare enough to live in CLI tools.
- **A per-key sensor readout.** Firmware SysEx `0x35` streams one key's raw sensor reading, but no tool is built on it (lessons.md → "The PIC's calibration mode").

---

## Caveats and known limits

- The 4-bit clamp on per-board SysEx commands (`0x29`/`0x2A` for max/min thresholds) does NOT apply to the per-key values in `KeyData_N` — those are 8-bit (0–254). Don't confuse the two; Calibrate Keys' sliders work with the 4-bit per-board values, the files with the 8-bit per-key ones.
- The PIC firmware has no per-key velocity LUT or per-key gain knob. Beyond MIN/MAX threshold tuning, residual per-key loudness differences must be corrected in HKL via per-key gain in `velocityCal.ts`.
- Sensor swing is a physical floor. A key whose ADC barely moves on full press will never have the dynamic range of a healthy key, no matter how the thresholds are tuned. The combination of (a) compressed-but-functional hardware thresholds, plus (b) HKL per-key gain to normalize loudness, is the realistic ceiling.
- `lmtn_launcher.sh`'s firmware-update hook runs only when a `Lumatone-v*.tgz` file is found at `/home/debian/` at boot, and the installer leaves `files/` alone (the 1.5.0 install kept every file byte-identical). Every boot also deletes any other `.tgz` in `/home/debian`, so don't keep backups there as tarballs. A package that fails to unpack is deleted and the application still starts under the 1.5.0 launcher; the 1.4.0 launcher aborted instead, leaving the boards frozen in their boot animation on every boot until the package was removed (lessons.md, 2026-11-08).
