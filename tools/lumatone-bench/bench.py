#!/usr/bin/env python3
"""Standalone, one-message-in-flight USB MIDI LED benchmark. See README.md."""
import argparse
from collections import Counter
from contextlib import ExitStack
import csv
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import platform
import queue
import signal
import sys
import time

MANUFACTURER = (0, 0x21, 0x50)
ALL_KEYS = [(board, key) for board in range(1, 6) for key in range(56)]
BASELINE_PHASES = ('single', 'board', 'grouped', 'interleaved', 'unchanged')
ROTATION_PHASES = ('board', 'interleaved2', 'interleaved3', 'interleaved')
PHASES = (*BASELINE_PHASES, 'interleaved2', 'interleaved3')


def packet(board, command, payload=(0, 0, 0, 0)):
    return (*MANUFACTURER, board, command, *payload)


def color_packet(board, key, rgb):
    return packet(board, 1, (key, *(n for v in rgb for n in (v >> 4, v & 15))))


def decode_rgb_channel(payload):
    if len(payload) != 112 or any(not 0 <= n <= 15 for n in payload):
        raise RuntimeError('Expected 112 RGB nibbles (56-key, 8-bit firmware); refusing writes')
    return [(payload[i] << 4) | payload[i + 1] for i in range(0, 112, 2)]


def validate_colors(colors):
    if (not isinstance(colors, list) or len(colors) != 280
            or any(not isinstance(rgb, list) or len(rgb) != 3
                   or any(type(v) is not int or not 0 <= v <= 255 for v in rgb)
                   for rgb in colors)):
        raise ValueError('Snapshot must contain 280 RGB triples in SysEx board/key order')
    return {k: tuple(rgb) for k, rgb in zip(ALL_KEYS, colors)}


def keys_for(phase, board, key, boards=None):
    if phase in ('single', 'unchanged'):
        return [(board, key)]
    if phase == 'board':
        return [(board, k) for k in range(56)]
    if phase == 'grouped':
        return ALL_KEYS
    if phase not in ('interleaved2', 'interleaved3', 'interleaved'):
        raise ValueError(f'Unknown phase: {phase}')
    count = {'interleaved2': 2, 'interleaved3': 3, 'interleaved': 5}[phase]
    return [(b, k) for k in range(56) for b in (boards if boards is not None else range(1, count + 1))]


def schedule_for(args):
    phases = args.phases or (ROTATION_PHASES if args.suite == 'rotation' else BASELINE_PHASES)
    repeats = args.repeats if args.repeats is not None else (4 if args.suite == 'rotation' else 1)
    schedule = []
    for repeat in range(repeats):
        ordered = phases if repeat % 2 == 0 else list(reversed(phases))
        reverse_boards = (repeat // 2) % 2 == 1
        for phase in ordered:
            board = args.boards[0] if args.suite == 'rotation' else args.board
            if phase in ('single', 'board', 'unchanged'):
                boards = [board]
            elif phase == 'grouped':
                boards = list(range(1, 6))
            else:
                count = {'interleaved2': 2, 'interleaved3': 3, 'interleaved': 5}[phase]
                # Select before reversing: changing direction must not change membership.
                boards = args.boards[:count]
                if reverse_boards:
                    boards = list(reversed(boards))
            schedule.append({'run_id': f'{len(schedule) + 1:02d}-{phase}',
                             'phase': phase, 'repeat': repeat + 1, 'boards': boards,
                             'phase_order': 'forward' if repeat % 2 == 0 else 'reverse',
                             'rotation_direction': 'reverse' if reverse_boards else 'forward'})
    return schedule


def next_color(current, white):
    return (white,) * 3 if current == (0, 0, 0) else (0, 0, 0)


class Client:
    """Callback timestamps avoid a MIDI polling interval in the measurements."""
    def __init__(self, timeout=2.0):
        self.inbox = queue.Queue()
        self.timeout = timeout
        self.events = []
        self.rows = []
        self.phase = 'setup'
        self.run_id = 'setup'
        self.send = None

    def receive(self, message):
        self.inbox.put((time.perf_counter_ns(), message))

    def observe(self, stamp, message):
        # Kept in memory until after timing; no disk writes in the hot loop.
        self.events.append((stamp, self.phase, self.run_id, message.type, str(message)))

    def exchange(self, data):
        # Anything already queued predates this request and cannot be its ACK.
        while True:
            try:
                self.observe(*self.inbox.get_nowait())
            except queue.Empty:
                break
        start = time.perf_counter_ns()
        row = {'phase': self.phase, 'run_id': self.run_id, 'board': data[3], 'command': data[4],
               'key': data[5] if data[4] == 1 else '',
               'sent_ns': start, 'received_ns': '', 'rtt_ms': '',
               'status': 'send_error', 'packet': ' '.join(f'{b:02x}' for b in data)}
        self.rows.append(row)
        self.send(data)
        deadline = start / 1e9 + self.timeout
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                row['status'] = 'timeout'
                raise TimeoutError(f'No ACK: board {data[3]}, command {data[4]:02x}')
            try:
                stamp, message = self.inbox.get(timeout=remaining)
            except queue.Empty:
                continue
            if message.type != 'sysex':
                self.observe(stamp, message)
                continue
            reply = tuple(message.data)
            if (stamp < start or len(reply) < 6
                    or reply[:5] != tuple(data[:5])):
                self.observe(stamp, message)
                continue
            row.update(received_ns=stamp, rtt_ms=(stamp - start) / 1e6,
                       status=reply[5])
            if reply[5] != 1:
                raise RuntimeError(f'Non-ACK status {reply[5]}: board {data[3]}, '
                                   f'command {data[4]:02x}; stopping, no automatic retry')
            return reply[6:]

    def settle(self):
        # After an uncertain write, give a late reply time to arrive and discard it.
        end = time.perf_counter() + self.timeout
        while time.perf_counter() < end:
            try:
                self.observe(*self.inbox.get(timeout=max(0, min(.1, end - time.perf_counter()))))
            except queue.Empty:
                pass

    def read_colors(self):
        colors = {}
        for board in range(1, 6):
            channels = [decode_rgb_channel(self.exchange(packet(board, cmd)))
                        for cmd in (0x13, 0x14, 0x15)]
            for key in range(56):
                colors[board, key] = tuple(ch[key] for ch in channels)
        return colors

    def verify(self, expected):
        actual = self.read_colors()
        wrong = [k for k in ALL_KEYS if actual[k] != expected[k]]
        if wrong:
            raise RuntimeError(f'RGB readback mismatch on {len(wrong)} keys; first: {wrong[:8]}')

    def restore(self, original):
        self.phase = 'restore'
        self.run_id = 'restore'
        self.settle()
        # Read actual state rather than trusting the last ACK after a failed write.
        actual = self.read_colors()
        for board, key in ALL_KEYS:
            if actual[board, key] != original[board, key]:
                self.exchange(color_packet(board, key, original[board, key]))
        self.verify(original)


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def distribution(values):
    return {'n': len(values), 'mean': sum(values) / len(values) if values else None,
            'p50': percentile(values, .5), 'p95': percentile(values, .95),
            'p99': percentile(values, .99), 'max': max(values, default=None)}


def timing_breakdown(rows):
    per_board = {str(b): [] for b in range(1, 6)}
    transitions = {'same_board': [], 'different_board': []}
    revisit_sent, revisit_acked, host_gaps = [], [], []
    last_board, previous = {}, None
    for row in rows:
        if row['status'] != 1:
            continue
        board = row['board']
        per_board[str(board)].append(row['rtt_ms'])
        if previous is not None:
            kind = 'same_board' if previous['board'] == board else 'different_board'
            transitions[kind].append(row['rtt_ms'])
            host_gaps.append((row['sent_ns'] - previous['received_ns']) / 1e6)
        if board in last_board:
            last = last_board[board]
            revisit_sent.append((row['sent_ns'] - last['sent_ns']) / 1e6)
            revisit_acked.append((row['sent_ns'] - last['received_ns']) / 1e6)
        last_board[board] = previous = row
    return {'rtt_by_board_ms': {b: distribution(v) for b, v in per_board.items() if v},
            'rtt_by_transition_ms': {k: distribution(v) for k, v in transitions.items()},
            'board_revisit_send_to_send_ms': distribution(revisit_sent),
            'board_revisit_ack_to_send_ms': distribution(revisit_acked),
            'host_ack_to_next_send_ms': distribution(host_gaps)}


def run_phase(client, state, spec, args, stopped, summaries):
    phase = spec['phase']
    client.phase = phase
    client.run_id = spec['run_id']
    keys = keys_for(phase, spec['boards'][0], args.key, spec['boards'])
    begin = time.perf_counter()
    row_start = len(client.rows)
    events_start = len(client.events)
    count = 0
    summary = {**spec, 'completed': False, 'readback_verified': False}
    summaries.append(summary)
    try:
        while time.perf_counter() - begin < args.seconds and not stopped():
            board, key = keys[count % len(keys)]
            rgb = state[board, key] if phase == 'unchanged' else next_color(state[board, key], args.white)
            client.exchange(color_packet(board, key, rgb))
            state[board, key] = rgb
            count += 1
        summary['completed'] = not stopped()
    finally:
        elapsed = time.perf_counter() - begin
        rows = client.rows[row_start:]
        latencies = [r['rtt_ms'] for r in rows if r['status'] == 1]
        summary.update(elapsed_s=elapsed, acked=count,
                       changed_acked=count if phase != 'unchanged' else 0,
                       updates_per_s=count / elapsed if elapsed else 0,
                       rtt_p50_ms=percentile(latencies, .5),
                       rtt_p95_ms=percentile(latencies, .95),
                       rtt_p99_ms=percentile(latencies, .99),
                       rtt_max_ms=max(latencies, default=None),
                       statuses=dict(Counter(str(r['status']) for r in rows)),
                       performance_midi=dict(Counter(e[3] for e in client.events[events_start:]
                                                    if e[3] != 'sysex')),
                       **timing_breakdown(rows))
    client.phase = phase + ':verify'
    client.verify(state)
    summary['readback_verified'] = True
    print(f"  {client.run_id:18} {summary['updates_per_s']:8.1f} ACK/s  "
          f"p50 {summary['rtt_p50_ms'] or 0:.2f} ms  "
          f"p95 {summary['rtt_p95_ms'] or 0:.2f} ms  RGB verified", flush=True)


def choose_port(names, requested):
    if requested is not None:
        if requested not in names:
            raise ValueError(f'Port not found: {requested!r}. Use --list.')
        return requested
    matches = [name for name in names if 'lumatone' in name.lower()]
    if len(matches) != 1:
        raise ValueError('Expected exactly one Lumatone port; use --list and --input/--output')
    return matches[0]


def write_json(path, value):
    # Exclusive creation prevents accidentally replacing an earlier recovery snapshot.
    with path.open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
        handle.flush()
        import os
        os.fsync(handle.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list', action='store_true', help='List MIDI ports without sending anything')
    parser.add_argument('--input', help='Exact MIDI input name; otherwise auto-detect Lumatone')
    parser.add_argument('--output', help='Exact MIDI output name; otherwise auto-detect Lumatone')
    parser.add_argument('--seconds', type=float, default=10, help='Seconds per phase (default 10)')
    parser.add_argument('--suite', choices=('baseline', 'rotation'), default='baseline',
                        help='Original benchmark or repeated 1/2/3/5-board comparison')
    parser.add_argument('--phases', nargs='+', choices=PHASES, help='Override the suite phases')
    parser.add_argument('--repeats', type=int, help='Passes; default baseline=1, rotation=4; phase order alternates')
    parser.add_argument('--boards', nargs=5, type=int, default=[1, 2, 3, 4, 5],
                        metavar='B', help='Permutation of SysEx boards; rotation tests use the first 1/2/3/5')
    parser.add_argument('--board', type=int, choices=range(1, 6), default=3,
                        help='SysEx board number for single/board/control phases (default 3)')
    parser.add_argument('--key', type=int, choices=range(56), default=28)
    parser.add_argument('--white', type=int, default=96, help='White RGB intensity 1–255 (default 96)')
    parser.add_argument('--timeout', type=float, default=2, help='ACK timeout seconds (default 2)')
    parser.add_argument('--out', type=Path, help='New output directory')
    parser.add_argument('--restore', type=Path, help='Restore snapshot.json from an earlier run, then exit')
    args = parser.parse_args()
    if (not math.isfinite(args.seconds) or args.seconds <= 0
            or not math.isfinite(args.timeout) or args.timeout <= 0
            or not 1 <= args.white <= 255):
        parser.error('seconds/timeout must be finite and positive; white must be 1–255')
    if sorted(args.boards) != [1, 2, 3, 4, 5] or (args.repeats is not None and args.repeats < 1):
        parser.error('boards must be a permutation of 1 2 3 4 5; repeats must be positive')
    schedule = schedule_for(args)
    try:
        import mido
        mido.set_backend('mido.backends.rtmidi')
        inputs, outputs = mido.get_input_names(), mido.get_output_names()
    except (ImportError, OSError, RuntimeError) as exc:
        parser.exit(1, f'MIDI unavailable: {exc}\nInstall requirements.txt in a venv; run on the USB-connected computer.\n')
    if args.list:
        print(json.dumps({'inputs': inputs, 'outputs': outputs}, indent=2))
        return 0
    input_name, output_name = choose_port(inputs, args.input), choose_port(outputs, args.output)
    out = args.out or Path(__file__).parent / 'out' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    out.mkdir(parents=True, exist_ok=False)
    client = Client(args.timeout)
    stop = False

    def request_stop(signum, frame):
        nonlocal stop
        stop = True  # Finish the outstanding transaction before restoration.

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    report = {'benchmark_version': 2, 'started_utc': datetime.now(timezone.utc).isoformat(),
              'platform': platform.platform(), 'python': sys.version,
              'input': input_name, 'output': output_name,
              'settings': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
              'schedule': schedule, 'phases': [], 'restored': False}
    original = None
    writes_started = False
    exit_code = 0
    print(f'Results: {out.resolve()}\nStop HKL Auto-sync and other SysEx writers before running.', flush=True)
    try:
        with ExitStack() as stack:
            stack.enter_context(mido.open_input(input_name, callback=client.receive))
            output = stack.enter_context(mido.open_output(output_name, autoreset=False))
            client.send = lambda data: output.send(mido.Message('sysex', data=data))
            try:
                firmware = client.exchange(packet(0, 0x31))
                if len(firmware) != 3:
                    raise RuntimeError(f'Unexpected firmware response: {firmware}')
                report['firmware'] = '.'.join(map(str, firmware))
                if tuple(firmware) < (1, 0, 11):
                    raise RuntimeError('Requires firmware >= 1.0.11 (8-bit RGB protocol)')
                if args.restore:
                    snapshot = json.loads(args.restore.read_text())
                    if snapshot.get('format') != 'hkl-lumatone-rgb-v1':
                        raise ValueError('Unrecognized snapshot format')
                    original = validate_colors(snapshot['colors'])
                    writes_started = True
                    client.restore(original)
                    report['restored'] = True
                else:
                    print('Reading and saving all 280 original colors…', flush=True)
                    original = client.read_colors()
                    write_json(out / 'snapshot.json', {
                        'format': 'hkl-lumatone-rgb-v1', 'firmware': report['firmware'],
                        'output': output_name, 'colors': [original[k] for k in ALL_KEYS]})
                    state = original.copy()
                    print(f'{len(schedule)} phases; {len(schedule) * args.seconds:g}s timed work '
                          'plus RGB verification/restoration.', flush=True)
                    for spec in schedule:
                        if stop:
                            break
                        print(f"Running {spec['run_id']} (pass {spec['repeat']}, "
                              f"boards {spec['boards']}, {args.seconds:g}s)…", flush=True)
                        writes_started = True
                        run_phase(client, state, spec, args, lambda: stop, report['phases'])
            except Exception as exc:
                report['error'] = str(exc)
                print(f'Benchmark stopped: {exc}', file=sys.stderr, flush=True)
                exit_code = 1
            finally:
                if writes_started and original is not None and not report['restored']:
                    print('Restoring original colors…', flush=True)
                    try:
                        client.restore(original)
                        report['restored'] = True
                    except Exception as exc:
                        report['restore_error'] = str(exc)
                        print(f'RESTORATION FAILED: {exc}. Use --restore with snapshot.json after reconnecting.',
                              file=sys.stderr, flush=True)
                        exit_code = 1
    except Exception as exc:
        report['port_error'] = str(exc)
        print(f'MIDI port error: {exc}', file=sys.stderr)
        exit_code = 1
    finally:
        report['interrupted'] = stop
        write_json(out / 'report.json', report)
        if client.rows:
            with (out / 'messages.csv').open('w', newline='') as handle:
                writer = csv.DictWriter(handle, fieldnames=list(client.rows[0]))
                writer.writeheader()
                writer.writerows(client.rows)
        with (out / 'incoming.csv').open('w', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(('received_ns', 'phase', 'run_id', 'type', 'message'))
            writer.writerows(client.events)
    print(f"Done. Restored: {report['restored']}. Report: {out / 'report.json'}", flush=True)
    return exit_code or (130 if stop else 0)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, FileExistsError) as exc:
        sys.exit(str(exc))
