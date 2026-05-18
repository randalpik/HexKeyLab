# Lumatone per-key calibration guide

This guide describes how to do **per-key threshold calibration** on a Lumatone whose built-in macro-button-driven calibration flow isn't usable (e.g., broken macro buttons), or when finer-grained control than the firmware's UI offers is needed. It works by editing the Lumatone's internal calibration state directly, via SSH plus a small set of Python scripts in `tools/lumatone-cal/`.

This is a **developer/maintenance** document, separate from the user-facing HKL guide. If you're not the keyboard's owner, don't run any of this — it modifies firmware state on a connected device.

---

## Why this exists

The Lumatone firmware ships a built-in calibration routine triggered by SysEx `0x24` (sysexCallibrateKeys). The user enters cal mode, plays through every key, and signals "done" by pressing the two macro buttons on each octave board. The firmware's per-key learning is committed and persisted at that point.

This breaks if the macro buttons don't work (mechanical failure, disconnected wires from a prior repair). The PIC microcontroller on the affected octave board waits for the hardware macro signal forever; nothing the host sends over MIDI or SysEx can substitute. Cal mode for those boards never completes, learned thresholds never persist, and individual problem keys remain stuck at their pre-cal values.

The approach in this guide bypasses the macro-button gate by writing per-key calibration values directly to the Lumatone's filesystem and to its running firmware's memory, with iterative tuning support so each key can be dialed in by ear in seconds.

---

## Lumatone internals (the minimum you need)

The Lumatone is, internally, a **BeagleBone Black running Debian** plus **five PIC microcontrollers** (one per octave board). Communication: UART `/dev/ttyO1`. MIDI to/from host: USB. The Lumatone exposes itself as a USB-ethernet gadget; the BBB has an IP on that interface (`192.168.6.2` for Linux hosts, `192.168.7.2` for Mac/Windows hosts).

The userspace firmware on the BBB is a single ARM ELF binary, `/home/debian/TerpstraController/TerpstraController`, launched in an infinite respawn loop by `/home/debian/TerpstraController/lmtn_launcher.sh`. The binary is **not stripped** and includes full DWARF debug info, which is why this calibration approach is even possible — we can find symbol addresses by name.

### Per-key state lives in two places

1. **On disk**: `/home/debian/TerpstraController/files/KeyData_1..5`. One file per octave board, plain text, comma-separated. Four sections per file (separated by newlines), 56 values per section (one per key):

   | Section | Meaning | Direction | Range |
   |---|---|---|---|
   | 1 | MAX threshold | "abs. distance from MAX ADC to trigger key events" — **HIGHER = stricter** (needs deeper press; if higher than physical ADC swing, key never registers). LOWER = lighter touch triggers. | 0–254 |
   | 2 | MIN threshold | Onset detection — distance from rest before the press-timer starts. Affects velocity-range compression. | 0–254 |
   | 3 | Validity | 0 = key disabled. 1 = key active. | 0/1 |
   | 4 | AT MAX threshold | Aftertouch trigger band. | 0–254 |

   These get loaded at every TC boot via `loadKeySetting`/`loadKeyThresholds`, and pushed to the PICs over UART as part of bootSequence.

2. **In running memory**: a `kbd_preset_params` struct in TC's `.bss`. Stride 638 bytes per board. Same four sections at offsets `+0x118`, `+0x150`, `+0x1c0`, `+0x1fe` relative to that board's slot. Slot `i` (0..4) corresponds to `KeyData_(i+1)`.

### Indexing quirk: spatial vs PIC

The in-memory struct is laid out by **PIC/SysEx board number** (1..5), not by spatial position. On Max's unit, boards 3 and 4 are *physically* swapped — what looks like spatial board 4 actually wires to PIC 5, and spatial board 5 wires to PIC 4. HKL handles this via `sysexBoardMap = [1, 2, 3, 5, 4]` (mapping HKL's spatial group index 0..4 to SysEx board ID 1..5).

When editing for a key at HKL coords (q, r):
- Find spatial `board_group = baseKeys_index // 56`
- `sysex_board = sysexBoardMap[board_group]`
- **Memory slot in TC = `sysex_board - 1`** (NOT `board_group`)
- File name = `KeyData_{sysex_board}`

The scripts handle all of this; just pass (q, r) from HKL's coords display.

### Direction reality check

The Hall sensors must be wired with **rest = high ADC, pressed = low ADC**. So MAX threshold = "how far ADC must drop from rest before triggering." A high MAX value means the key has to travel a long way — if its physical sensor swing is small (weak magnet, alignment drift), it can't reach the threshold and appears dead. Lowering MAX makes the key responsive at lighter touches.

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

## Installation (one-time, ~5 minutes)

You'll need:
- SSH access to the Lumatone (USB-network connection active when the Lumatone is plugged in)
- Python 3.5+ on the device (default on the shipped Debian image)
- Local Python 3 (any modern version) for the locator helper

### One-time setup

```bash
# 1. Confirm you can reach the device. On Linux:
ping -c 1 192.168.6.2          # (on Mac/Windows: 192.168.7.2)

# 2. Confirm SSH access. Password: temppwd
ssh debian@192.168.6.2 'echo ok && python3 --version'

# 3. Copy the scripts onto the device.
scp tools/lumatone-cal/keydata-live.py debian@192.168.6.2:/home/debian/
scp tools/lumatone-cal/keydata-locate.py debian@192.168.6.2:/home/debian/
scp tools/lumatone-cal/lmtncal-read.py debian@192.168.6.2:/home/debian/

# 4. Snapshot the current KeyData files into a persistent backup
#    (the /tmp dir on the BBB is tmpfs — wiped at every reboot, so use $HOME).
ssh debian@192.168.6.2 'mkdir -p ~/keydata-backup-$(date +%Y%m%d) && cp /home/debian/TerpstraController/files/KeyData_? ~/keydata-backup-$(date +%Y%m%d)/'
```

That's it. From here on, all calibration work uses these scripts.

---

## The scripts

All live in `tools/lumatone-cal/`.

### `keydata-locate.py` (run locally)

Inspects a local copy of KeyData files. Given a lattice (q, r), prints which file and which slot holds that key's bytes, plus current values.

```bash
python3 tools/lumatone-cal/keydata-locate.py <q> <r> [PATH/TO/files/dir]
```

If you've copied the KeyData files locally to `/home/max/lumatone/TerpstraController/files/`, point at that. Useful for offline exploration without an SSH session.

### `keydata-live.py` (run on the Lumatone via SSH)

The main tool. Single-key, bulk, and persist modes:

```bash
# READ current in-memory values for a key
sudo python3 /home/debian/keydata-live.py --read <q> <r>

# SET a single threshold live (~1 main-loop tick to propagate to the PIC)
# section: 1=MAX, 2=MIN, 3=validity, 4=AT_MAX
# value: 0-254 (or 0/1 for validity)
sudo python3 /home/debian/keydata-live.py <q> <r> <section> <value>

# BULK SET all 280 keys at once — clobbers prior per-key edits
sudo python3 /home/debian/keydata-live.py --bulk <section> <value>

# BULK RAISE — only writes keys whose current value is BELOW the target.
# Establishes a floor. NOT rescue-preserving: a rescue below the target
# will be raised. Use --bulk-change for rescue-preserving sweeps.
sudo python3 /home/debian/keydata-live.py --bulk-raise <section> <value>

# BULK LOWER — symmetric; only writes keys with current > target.
sudo python3 /home/debian/keydata-live.py --bulk-lower <section> <value>

# BULK CHANGE — only writes keys whose current value EQUALS <from>.
# The rescue-preserving primitive: bumps the old baseline to a new
# baseline without touching any key whose value already differs. Use
# for the iterative MAX-raising loop.
sudo python3 /home/debian/keydata-live.py --bulk-change <section> <from> <to>

# COMMIT current in-memory state of ALL boards to disk (KeyData_1..5)
sudo python3 /home/debian/keydata-live.py --commit
```

How it works: writes the byte at the right address in `/proc/<TC pid>/mem`, then sets the matching bit in `picMessage0Flag[mem_slot]`. TC's `writeToPic` dispatcher picks the bit up on its next pass and sends the section to the PIC via UART. The PIC's per-key threshold is updated in its volatile state.

**In-memory edits do NOT persist across reboot**. Run `--commit` when you're happy with the values. Commit reads the current state of all 5 in-memory slots and writes back to `KeyData_1..5` on disk; the first commit auto-saves `.bak` files alongside the originals.

### `lmtncal-read.py` (diagnostic, on the Lumatone via SSH)

Dumps the relevant TC firmware state for all five boards: `picMessage0Flag`, three `enum_octave.*` arrays, `clockStartFlag`, `lmtn_state`. Useful for debugging calibration flow if something weird happens.

```bash
sudo python3 /home/debian/lmtncal-read.py
```

### `lmtncal-poke.py` (obsolete, kept for diagnostic reference)

An earlier attempt at spoofing the macro-button signal at the BBB level. **Doesn't work** for stuck-PIC boards because the PIC firmware blocks at its own hardware-event level, not at the BBB level. See `docs/lessons.md` for the full diagnosis. Don't use this for calibration; use `keydata-live.py` instead.

---

## Workflow: full-keyboard calibration

Diagnose the hardware envelope first, then choose between hardware MAX-raising (works on some units, fails on others) and software input-curve shaping (works on every unit). Phase 3 (per-key MIN tuning) is independent and useful regardless. ~1 hour total.

### Phase 0 — sane baseline

1. **Push identity LUT** from HKL's lumadiag panel (Hardware foundation → "Push identity LUT to Lumatone"). Makes the firmware emit its full 0-127 range.
2. **Seed all KeyData files with a known baseline**:
   ```bash
   # Copy the project's default (MAX=70 / MIN=0 / valid=1 / AT_MAX=200) to all 5 boards:
   scp tools/lumatone-cal/KeyData_default debian@192.168.6.2:/tmp/
   ssh debian@192.168.6.2 'for n in 1 2 3 4 5; do sudo cp /tmp/KeyData_default /home/debian/TerpstraController/files/KeyData_$n; done && sudo reboot'
   ```
   After reboot, every key is at a permissive baseline that gets onsets working everywhere.

### Phase 1 — collect velocity statistics

3. Open `?lumadiag=1` in HKL. Enable "Collect" in the **Per-key velocity statistics** section.
4. Play every key 30-50 times across the full range of forces you'd use in normal play. The scatter populates with each key's (p5, p95) point. Two clusters typically emerge:
   - **Top-right cluster**: p5 >> 30, p95 close to 127. Keys saturate high — soft presses still register as forte.
   - **Diagonal-middle cluster**: p5 around 50-80, p95 around 80-100. Keys stuck in the middle of the velocity range.

### Phase 2 — probe the hardware envelope, then choose a lever

5. **One diagnostic MAX bump.** Push MAX from 70 → 80 globally:
   ```bash
   sudo python3 /home/debian/keydata-live.py --bulk-change 1 70 80
   ```
   Play every key. Count "dead" keys (no onset).
   - **< ~5 dead keys**: hardware MAX-raising is viable on this unit. Continue with the **Phase 2a (hardware path)** below.
   - **≥ ~10 dead keys**: the unit's ADC swing distribution is too tight for MAX-raising to pay off. Revert MAX:
     ```bash
     sudo python3 /home/debian/keydata-live.py --bulk-change 1 80 70
     sudo python3 /home/debian/keydata-live.py --commit
     ```
     and skip to **Phase 2b (software path)**.

   See `docs/lessons.md` → "Hardware MAX is not a reliable dynamic-range lever for narrow-ADC-swing keyboards" and `docs/decisions.md` → "Velocity shaping: software input curve over hardware MAX raising" for the reasoning.

### Phase 2a — hardware path: iterative MAX raising (only if the diagnostic was friendly)

6. **First raise (modest):**
   ```bash
   sudo python3 /home/debian/keydata-live.py --bulk-change 1 70 100
   ```
   Play every key. Some go dead (physical ADC swing < 100). Rescue them individually:
   ```bash
   sudo python3 /home/debian/keydata-live.py <q> <r> 1 80   # pick a value not equal to the current baseline
   ```
   so subsequent `--bulk-change` passes won't catch the rescue.
7. **Second raise:** `--bulk-change 1 100 130`. Same play-through and rescue cycle. `--bulk-change` is the rescue-preserving primitive: it only touches keys still at the old baseline.
8. **Third raise:** `--bulk-change 1 130 160`. Fewer casualties each pass.
9. **Stop** when further raises stop helping the "Can't play quiet" outlier list — you've hit the keyboard's physical ceiling for low-end reach.

### Phase 2b — firmware path: velocity interval table (CMD 0x20)

10. In the lumadiag panel, find the **Hardware velocity intervals (CMD 0x20)** subsection (between "Hardware foundation" and "HKL curve"). The faint trace on the preview canvas is the Terpstra factory default; the bright line is your current curve. Defaults match the factory (`low=1, high=310, gamma≈2.1`).
11. With stats still collecting, narrow `high` toward the slowest press-time tick count your keyboard actually produces. The factory's `high=310` is generous; compressed-range keyboards live much lower (often 60–200). Lower `high` packs more bins into the press-time range you actually use → more distinct emitted velocities.
12. `low` adjusts the fast-press end. Usually leave at 1 unless your fastest presses are slower than the factory assumes (rare).
13. `gamma` controls bin distribution. Factory ~2.1 concentrates bins at fast presses. Lower gamma (e.g. 1.5) spreads bins more evenly; higher gamma (3+) tightens further at the fast end.
14. Click **Push to Lumatone (CMD 0x20)**. The firmware accepts the table immediately and starts using it for the next note-on. Replay the keyboard and watch the (p5, p95) scatter — clusters should spread out (more distinct values reachable) and per-key histograms should show finer gradation.
15. Iterate until further narrowing of `high` stops widening the scatter — you've packed the bins as tightly as the press-time data supports.
16. **Persistence caveat**: CMD 0x20's EEPROM behavior is unverified. After a Lumatone power cycle, the firmware may revert to factory defaults — if so, click Push again. (`localStorage` retains your curve parameters across browser sessions, so re-pushing is one click.)

### Phase 3 — MIN tuning for high-end reach (independent of Phase 2 path)

14. For keys still in the "Can't play loud" list (p95 < 100):
    ```bash
    sudo python3 /home/debian/keydata-live.py <q> <r> 2 15
    ```
    Try MIN = 10, 20, 30. This narrows the press-time measurement window, pushing reported velocities upward. Stop when p95 saturates or p5 creeps back up.

### Phase 4 — persist + HKL-side residuals

15. **Commit:** `sudo python3 /home/debian/keydata-live.py --commit`. Reboot to verify TC loads the persisted values cleanly.
16. **Remaining range gaps** (e.g. a few outlier keys whose loudness still drifts after global shaping): use HKL's per-key gain + audio-stage curve in the lumadiag "HKL curve" section. The per-key gain adjusts per-key loudness offset; the curve's `gamma` parameter compresses the low end further in audio gain space.

### Tips

- **Live edits are volatile.** If you want a rescue level to survive a TC crash, run `--commit` after each pass. Otherwise just commit at the end.
- **Don't rush the play-through.** A key only appears alive in the scatter if you strike it after the change. Hit every key several times.
- **Backups exist** as `KeyData_N.bak` after the first `--commit`. If a pass goes catastrophically wrong: `cp KeyData_N.bak KeyData_N && sudo reboot` returns to the prior committed state.

### Bulk seeding a board

If you have a known-good calibration on one board and want to use it as the baseline for a board that's never been calibrated:

```bash
# On the Lumatone:
sudo cp /home/debian/TerpstraController/files/KeyData_2 /home/debian/TerpstraController/files/KeyData_1
sudo reboot
```

After reboot, board 1's PICs get loaded with board 2's per-key thresholds. Not optimal (sensor variance differs between boards) but a much better starting point than the unknown shipped defaults. Then iterate per-key from there using `keydata-live.py`.

---

## Recovery and safety

### Undo an in-memory edit

Power-cycle the Lumatone. TC restarts, reads `KeyData_N` from disk, pushes those values to the PICs. Volatile in-memory changes are lost.

### Restore a single file

```bash
# On the Lumatone:
sudo cp /home/debian/TerpstraController/files/KeyData_1.bak /home/debian/TerpstraController/files/KeyData_1
sudo reboot
```

### Full restore from the dated backup taken during install

```bash
sudo cp ~/keydata-backup-20260515/KeyData_? /home/debian/TerpstraController/files/
sudo reboot
```

### TC crashed / device unresponsive

The launcher script (`lmtn_launcher.sh`) is `while :; do sudo TerpstraController; done`. If TC dies, it restarts automatically. No on-disk state is damaged by a TC crash. Power-cycle (unplug, wait 5 seconds, replug) if anything looks weird — that's a clean reset.

### Lumatone factory reset

Beyond what's in this guide, the Lumatone supports a full factory reset via SysEx commands `0x0A` (velocity LUT), `0x12` (AT LUT), `0x2F` (Lumatouch LUT), `0x34` per board (per-board thresholds), `0x46` (preset slots), and the helper `tools/lumatone-cal/reset-calibration.sh` bundles several of these. None of those touch the per-key KeyData files; only the `--commit` action in `keydata-live.py` or a manual edit will.

---

## What's deliberately NOT here

- **A vendor SysEx that does this over MIDI.** That would require running a daemon on the BBB that translates SysEx → memory pokes. The current flow requires SSH for calibration sessions but not for everyday play. If you want to skip SSH entirely later, see the deferred Phase 2 work in `~/.claude/plans/eager-bouncing-koala.md`.
- **A GUI in HKL for per-key threshold editing.** HKL handles software-side per-key gain and velocity curves (see `src/audio/velocityCal.ts`), which is enough for normal use. Direct hardware-side calibration is rare enough to live in CLI tools.
- **Velocity LUT or interval table editing.** Those exist (CMD `0x08` and `0x20`) and are global, not per-key. The lumadiag panel exposes "Push identity velocity LUT" which is the primary tunable.

---

## Caveats and known limits

- The 4-bit clamp on per-board SysEx commands (`0x29`/`0x2A` for max/min thresholds) does NOT apply to the per-key writes in `KeyData_N` — those are 8-bit (0–254). Don't confuse the two; the lumadiag UI works with the 4-bit per-board values, this tool with the 8-bit per-key.
- The PIC firmware has no per-key velocity LUT or per-key gain knob. Beyond MIN/MAX threshold tuning, residual per-key loudness differences must be corrected in HKL via per-key gain in `velocityCal.ts`.
- Sensor swing is a physical floor. A key whose ADC barely moves on full press will never have the dynamic range of a healthy key, no matter how the thresholds are tuned. The combination of (a) compressed-but-functional hardware thresholds, plus (b) HKL per-key gain to normalize loudness, is the realistic ceiling.
- `lmtn_launcher.sh`'s firmware-update hook runs only when a `Lumatone-v*.tgz` file is found at `/home/debian/` at boot. As long as you don't put one there, your `KeyData_N` edits will not be overwritten.
