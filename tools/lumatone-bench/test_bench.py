"""Hardware-free protocol and failure-path checks; python3 -m unittest -v."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import signal
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bench


def message(data=(), kind='sysex'):
    return SimpleNamespace(type=kind, data=data)


class ProtocolTests(unittest.TestCase):
    def test_rgb_nibble_order_and_invalid_readback(self):
        self.assertEqual(bench.color_packet(5, 55, (0x12, 0xab, 0xff)),
                         (0, 0x21, 0x50, 5, 1, 55, 1, 2, 10, 11, 15, 15))
        self.assertEqual(bench.decode_rgb_channel([10, 11] * 56), [171] * 56)
        for data in ([1] * 56, [0] * 111, [16, 0] * 56):
            with self.assertRaises(RuntimeError):
                bench.decode_rgb_channel(data)

    def test_unrelated_replies_and_notes_do_not_complete_transaction(self):
        client = bench.Client(.01)
        client.receive(message(bench.packet(3, 1, (1,))))  # Stale matching ACK.

        def send(data):
            client.receive(message(kind='note_on'))
            client.receive(message(bench.packet(4, 1, (1,))))  # Wrong board.
            client.receive(message(bench.packet(3, 0x3e, (1,))))  # Spontaneous calibration.
            client.receive(message((0, 1, 2, 3, 1, 1)))  # Wrong manufacturer.
            client.receive(message(bench.packet(3, 1, (1,))))

        client.send = send
        self.assertEqual(client.exchange(bench.color_packet(3, 0, (0, 0, 0))), ())
        self.assertEqual(len(client.events), 5)
        self.assertEqual(client.rows[0]['status'], 1)

    def test_timeout_and_rejection_do_not_advance_or_retry(self):
        for status in (None, 0, 2, 3, 4):
            client = bench.Client(.001)
            sent = []

            def send(data):
                sent.append(data)
                if status is not None:
                    client.receive(message(bench.packet(data[3], data[4], (status,))))

            client.send = send
            with self.assertRaises((RuntimeError, TimeoutError)):
                client.exchange(bench.color_packet(3, 0, (0, 0, 0)))
            self.assertEqual(len(sent), 1)
            self.assertEqual(client.rows[0]['status'], status if status is not None else 'timeout')

    def test_patterns_have_unique_physical_addresses(self):
        for phase in ('grouped', 'interleaved'):
            self.assertEqual(set(bench.keys_for(phase, 3, 28)), set(bench.ALL_KEYS))
        self.assertEqual(bench.keys_for('interleaved', 3, 28)[:5], [(b, 0) for b in range(1, 6)])
        for rgb in ((0, 0, 0), (96, 96, 96), (12, 70, 201)):
            self.assertNotEqual(bench.next_color(rgb, 96), rgb)

    def test_snapshot_validation(self):
        for colors in ([], [[0, 0, 999]] * 280, [[True, 0, 0]] * 280):
            with self.assertRaises(ValueError):
                bench.validate_colors(colors)

    def test_rotation_schedule_keeps_membership_when_reversing(self):
        args = SimpleNamespace(suite='rotation', phases=None, repeats=None,
                               boards=[3, 5, 1, 4, 2], board=2)
        schedule = bench.schedule_for(args)
        self.assertEqual(len(schedule), 16)
        self.assertEqual(len({s['run_id'] for s in schedule}), 16)
        self.assertEqual([s['phase'] for s in schedule[:4]], list(bench.ROTATION_PHASES))
        self.assertEqual([s['phase'] for s in schedule[4:8]], list(reversed(bench.ROTATION_PHASES)))
        for count, phase in ((1, 'board'), (2, 'interleaved2'),
                             (3, 'interleaved3'), (5, 'interleaved')):
            specs = [s for s in schedule if s['phase'] == phase]
            for spec in specs:
                expected = args.boards[:count]
                if spec['repeat'] >= 3:
                    expected = list(reversed(expected))
                self.assertEqual(spec['boards'], expected)
                keys = bench.keys_for(phase, spec['boards'][0], 28, spec['boards'])
                self.assertEqual(len(keys), 56 * count)
                self.assertEqual(set(keys), {(b, k) for b in expected for k in range(56)})
                if count > 1:
                    self.assertTrue(all(keys[i][0] != keys[(i + 1) % len(keys)][0]
                                        for i in range(len(keys))))

    def test_timing_breakdown_separates_host_delay_and_board_revisits(self):
        rows = [dict(board=b, sent_ns=s * 1000000, received_ns=r * 1000000,
                     rtt_ms=r-s, status=1) for b, s, r in
                [(1, 0, 3), (2, 4, 7), (1, 8, 11), (1, 12, 20)]]
        stats = bench.timing_breakdown(rows)
        self.assertEqual(stats['rtt_by_transition_ms']['same_board']['mean'], 8)
        self.assertEqual(stats['rtt_by_transition_ms']['different_board']['mean'], 3)
        self.assertEqual(stats['board_revisit_send_to_send_ms']['mean'], 6)
        self.assertEqual(stats['board_revisit_ack_to_send_ms']['mean'], 3)
        self.assertEqual(stats['host_ack_to_next_send_ms']['mean'], 1)
        self.assertEqual(stats['rtt_by_board_ms']['1']['n'], 3)


class Device:
    """A device whose writes can apply but time out, or be rejected outright."""
    def __init__(self, out, failure=None):
        self.out = out
        self.failure = failure
        self.colors = {k: (17, 34, 51) for k in bench.ALL_KEYS}
        self.original = self.colors.copy()
        self.writes = 0
        self.changed = []
        self.callback = None
        self.signals = {}
        self.recovery = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def send(self, msg):
        data = tuple(msg.data)
        board, cmd = data[3:5]
        payload = ()
        status = 1
        if cmd == 0x31:
            payload = (1, 0, 12)
        elif cmd in (0x13, 0x14, 0x15):
            if self.failure == 'bad_snapshot':
                payload = (0,) * 56
            else:
                channel = cmd - 0x13
                payload = tuple(n for key in range(56)
                                for n in (self.colors[board, key][channel] >> 4,
                                          self.colors[board, key][channel] & 15))
        elif cmd == 1:
            assert self.recovery or (self.out / 'snapshot.json').exists(), 'Write before recovery snapshot'
            self.writes += 1
            if self.writes >= 3 and self.failure == 'disconnect':
                raise OSError('Device disconnected')
            key = board, data[5]
            rgb = tuple((data[i] << 4) | data[i + 1] for i in (6, 8, 10))
            self.changed.append(rgb != self.colors[key])
            if self.writes == 3 and self.failure == 'nack':
                status = 0
            else:
                self.colors[key] = rgb
            if self.writes == 3 and self.failure == 'timeout':
                return  # Applied, but no ACK: restoration must re-read actual state.
            if self.writes == 3 and self.failure == 'interrupt':
                self.signals[signal.SIGINT](signal.SIGINT, None)
        else:
            raise AssertionError(f'Unexpected write command: {cmd}')
        time.sleep(.0001)
        self.callback(message(bench.packet(board, cmd, (status, *payload))))

    def open_input(self, name, callback):
        self.callback = callback
        return self

    def module(self):
        return SimpleNamespace(set_backend=lambda _: None,
                               get_input_names=lambda: ['Lumatone'],
                               get_output_names=lambda: ['Lumatone'],
                               open_input=self.open_input,
                               open_output=lambda *a, **kw: self,
                               Message=lambda kind, data: message(data, kind))


class LifecycleTests(unittest.TestCase):
    def run_device(self, failure=None, extra_args=()):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'run'
            device = Device(out, failure)
            args = ['bench.py', '--seconds', '.003', '--timeout', '.002', '--out', str(out)]
            args.extend(extra_args)
            with patch.object(sys, 'argv', args), patch.dict(sys.modules, mido=device.module()), \
                    patch('signal.signal', side_effect=lambda s, f: device.signals.__setitem__(s, f)), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = bench.main()
            return code, device, json.loads((out / 'report.json').read_text())

    def test_success_measures_changes_separately_from_noops_and_restores(self):
        code, device, report = self.run_device()
        self.assertEqual(code, 0)
        self.assertTrue(report['restored'])
        self.assertEqual(device.colors, device.original)
        self.assertEqual(len(report['phases']), 5)
        self.assertTrue(all(p['readback_verified'] for p in report['phases']))
        self.assertEqual(report['phases'][-1]['changed_acked'], 0)
        changed = sum(p['acked'] for p in report['phases'][:-1])
        self.assertTrue(all(device.changed[:changed]))
        self.assertFalse(any(device.changed[changed:changed + report['phases'][-1]['acked']]))

    def test_partial_failure_and_interrupt_restore_actual_device(self):
        for failure, expected_code in (('nack', 1), ('timeout', 1), ('interrupt', 130)):
            with self.subTest(failure=failure):
                code, device, report = self.run_device(failure)
                self.assertEqual(code, expected_code)
                self.assertTrue(report['restored'])
                self.assertEqual(device.colors, device.original)

    def test_rotation_suite_executes_all_repeats_and_restores(self):
        code, device, report = self.run_device(extra_args=('--suite', 'rotation', '--seconds', '.012'))
        self.assertEqual(code, 0)
        self.assertEqual(len(report['phases']), 16)
        self.assertEqual(device.colors, device.original)
        self.assertTrue(report['restored'])
        for phase, planned in zip(report['phases'], report['schedule']):
            self.assertEqual(phase['run_id'], planned['run_id'])
            self.assertTrue(phase['readback_verified'])
            self.assertTrue(phase['completed'])
            self.assertEqual(phase['changed_acked'], phase['acked'])
            self.assertEqual(set(phase['rtt_by_board_ms']), set(map(str, phase['boards'])))
            kind = 'same_board' if phase['phase'] == 'board' else 'different_board'
            self.assertEqual(phase['rtt_by_transition_ms'][kind]['n'], phase['acked'] - 1)
        self.assertTrue(all(device.changed))

    def test_unreadable_snapshot_prevents_all_color_writes(self):
        code, device, report = self.run_device('bad_snapshot')
        self.assertEqual(code, 1)
        self.assertEqual(device.writes, 0)
        self.assertFalse(report['restored'])

    def test_restore_failure_is_explicit(self):
        code, device, report = self.run_device('disconnect')
        self.assertEqual(code, 1)
        self.assertFalse(report['restored'])
        self.assertIn('Device disconnected', report['restore_error'])

    def test_recovery_command_restores_saved_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / 'snapshot.json'
            snapshot.write_text(json.dumps({'format': 'hkl-lumatone-rgb-v1',
                                            'colors': [[0, 0, 0]] * 280}))
            out = Path(directory) / 'recovery'
            device = Device(out)
            device.recovery = True
            args = ['bench.py', '--restore', str(snapshot), '--out', str(out), '--timeout', '.002']
            with patch.object(sys, 'argv', args), patch.dict(sys.modules, mido=device.module()), \
                    patch('signal.signal'), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(bench.main(), 0)
            self.assertTrue(all(rgb == (0, 0, 0) for rgb in device.colors.values()))
            self.assertEqual(device.writes, 280)
            self.assertTrue(json.loads((out / 'report.json').read_text())['restored'])


if __name__ == '__main__':
    unittest.main()
