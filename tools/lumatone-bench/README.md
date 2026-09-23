# Lumatone USB LED benchmark

Standalone Python/RtMidi scratch harness. No HKL app, dev server, firmware edits,
or shared repo dependencies. Run on the computer connected to the Lumatone by
**USB MIDI**. Requires Python 3.10+ and Lumatone firmware 1.0.11+ with 56 keys/board.

```sh
cd /home/max/HexKeyLab/tools/lumatone-bench
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python bench.py --list
.venv/bin/python bench.py
```

Before running, turn **HKL Auto-sync OFF**, let any outgoing work finish, and
close the Lumatone Editor/other SysEx writers. HKL can remain open for audio;
avoid calibration, tuning controls that send SysEx, and reconnecting it during
the run. The protocol has no transaction/key ID in ACKs, so another writer can
invalidate measurements and restoration. The benchmark never sends note events,
changes mappings/aftertouch/pedals, or saves a preset. Keystroke lighting is left
as configured; it can temporarily change visible brightness while you play.

If auto-detection is ambiguous, copy exact names from `--list`:

```sh
.venv/bin/python bench.py --input 'Lumatone input name' --output 'Lumatone output name'
```

## What runs

For the **board-rotation follow-up**, run:

```sh
.venv/bin/python bench.py --suite rotation
```

This compares **one, two, three, and five boards**, changing colors on each visit
and cycling through all 56 key indices on each selected board. Four passes control
for test order and rotation direction:

| Pass | Test order (number of boards) | Board rotation direction |
| --- | --- | --- |
| 1 | 1 → 2 → 3 → 5 | Forward |
| 2 | 5 → 3 → 2 → 1 | Forward |
| 3 | 1 → 2 → 3 → 5 | Reverse |
| 4 | 5 → 3 → 2 → 1 | Reverse |

Default board subsets are `[1]`, `[1,2]`, `[1,2,3]`, and `[1,2,3,4,5]`.
Reversing direction reverses each subset, **without changing its membership**.
The one-board phase is `board`, two/three are `interleaved2`/`interleaved3`, and
five is `interleaved`. The default is 16 × 10 seconds = **160 seconds of timed
work**, plus verification and restoration; allow about three minutes. `--seconds`
and `--repeats` override duration and pass count. Phase order alternates each pass;
rotation direction alternates every two passes. To test different board subsets:

```sh
.venv/bin/python bench.py --suite rotation --boards 3 4 5 1 2
```

`--boards` must contain each SysEx board once; tests take the first 1/2/3/5 entries.
The rotation suite's one-board baseline uses its first entry; `--board` still
selects the single-board target in the original baseline suite.

The initial measured run reached ~316 changed keys/sec interleaved versus
~121–126/sec for same-board/grouped traffic. Max reports the same timing while
playing. This follow-up focuses on board pacing: whether two-board alternation
already gets the gain, and whether it survives reversing order/direction. No
extra playing-versus-idle run is required for this question.

The **original suite** is still the default (`bench.py` or `--suite baseline`):

The harness queries firmware, reads all 280 RGB settings, and writes an fsynced
`snapshot.json` **before the first color change**. Unsupported or malformed
readback aborts without color writes. It then runs these phases for 10 seconds each:

| Phase | Pattern |
| --- | --- |
| `single` | Repeated black/white changes to one key |
| `board` | Cycle through 56 keys on one board, changing each on every visit |
| `grouped` | All 280 keys, board 1 then 2 … 5 |
| `interleaved` | All 280 keys, cycle boards 1 … 5 for each key index |
| `unchanged` | Repeated identical color on one key: fast-ACK control only |

`--phases` can override either suite's phase list. `--repeats 4` also enables the
four-pass order/direction schedule for a custom list.

All changed-color phases guarantee a value different from the previous ACKed
value, including the first write after the snapshot. “White” is RGB (96,96,96)
by default; `--white 255` selects full white. A global scene inversion and a
single blinking key are visually different; the phase names make this explicit.
All addressing is **SysEx board 1–5 / key 0–55**, not HKL spatial board order.
The physical board swap does not affect coverage or restoration.

One request is outstanding at a time; the next is sent as soon as the previous
ACK is consumed. There is no intentional pacing delay or polling sleep. This
measures the native host/USB/firmware/PIC stop-and-wait path. It does **not** claim
to find the absolute hardware ceiling or test unsafe unacknowledged bursts.

Each phase's final RGB readback is checked outside the timing window. Readback
is controller state, not optical verification: watch or film the board as well.
The changed-write PIC-ACK path was identified in the local firmware binary;
firmware versions may differ. No-op ACK/s must not be interpreted as LED throughput.

## Suggested runs

For longer rotation measurements (four minutes timed work):

```sh
.venv/bin/python bench.py --suite rotation --seconds 15
```

Optional original-suite comparisons, with HKL Auto-sync still off:

```sh
.venv/bin/python bench.py --seconds 15 --out out/idle
.venv/bin/python bench.py --seconds 15 --out out/playing
```

Directories must be new. To compare individual boards:

```sh
.venv/bin/python bench.py --phases single board --board 1 --seconds 15
```

Repeat with boards 2–5. `--key` selects the single-key phase's index (default 28),
and `--board` defaults to 3. Allow about a minute for the default run plus snapshot,
verification, and restoration. Ctrl+C/SIGTERM stops after the outstanding exchange
and restores colors. A timeout, BUSY, NACK, or malformed readback ends testing;
the harness does not retry questionable measurements and count them as successes.

## Results and recovery

Each run produces an ignored `out/<timestamp>/` directory (or `--out`):

- `report.json`: firmware/ports/platform/settings, per-phase ACK/s, p50/p95/p99/max
  ACK latency, status counts, incoming MIDI counts, verification and restoration status.
  Version 2 includes the exact planned schedule, unique `run_id`, pass number,
  selected boards/direction, per-board RTT, same-board versus different-board RTT,
  host ACK-to-next-send gaps, and board revisit intervals (previous send/ACK to
  next send on that same board). Timing distributions include n/mean/p50/p95/p99/max
  in milliseconds, computed within each phase only. The first write has no prior
  transition/revisit sample. Compare all repeats rather than only the fastest one.
- `messages.csv`: every transaction, phase, board/key, outgoing bytes, monotonic
  send/receive timestamps, status and RTT. `run_id` distinguishes repeated phases;
  setup/readback/restore are labeled separately.
- `incoming.csv`: observed note/CC/aftertouch traffic and unrelated SysEx with callback
  timestamps. This counts observed traffic; without a known source stream it cannot
  prove absence of dropped notes or measure physical key-to-audio latency.
- `snapshot.json`: original RGB settings in SysEx board/key order, for recovery.

Normal exit, Ctrl+C, and errors attempt restoration, then verify all RGB values.
A disconnected device or killed process cannot restore itself; reconnect, stop
other SysEx writers, and run:

```sh
.venv/bin/python bench.py --restore out/PREVIOUS-RUN/snapshot.json
```

Restoration failure is explicit and returns nonzero. Re-enable HKL Auto-sync
afterward if desired. No presets are saved by this tool.

For display planning use **changed updates/sec**, its tail latency, and the
idle-versus-playing difference. At rate R, a fully changed frame takes at least
280/R seconds; a target rate F can sustain R/F changed keys/frame on average.
Actual Bad Apple demand and visual loss still need the spatial-frame simulation.

## Hardware-free checks

```sh
python3 -m unittest discover -s tools/lumatone-bench -v
```

Run that from the repo root; no MIDI dependencies required. Tests exercise
response filtering, rejection/timeout handling, changed/no-op separation, and
full-run restoration after partial writes and interruption against a fake device.
Rotation checks cover constant board membership, cyclic alternation, all 16
passes, exact timing-summary arithmetic, and restoration after the repeated suite.

MIDI API references: [Mido ports/callbacks](https://mido.readthedocs.io/en/stable/ports/index.html)
and [RtMidi backend](https://mido.readthedocs.io/en/stable/backends/rtmidi.html).
Protocol reference: local `TerpstraMidiDriver.cpp` LED read/write routines and
HKL's `apps/hkl/src/lumatone/protocol.ts`. This scratch tool imports neither.
