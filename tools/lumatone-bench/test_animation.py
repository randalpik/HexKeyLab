from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import animation
import bench
from test_bench import Device, message


def frame(*indices):
    return ''.join('1' if i in indices else '0' for i in range(280))


def movie(frames):
    return {'format': animation.FORMAT, 'fps': 30, 'frames': frames,
            'points': animation.geometry(), 'mapping': {'vertical_scale': .75}}


class GrayscaleTests(unittest.TestCase):
    def test_quantization_hysteresis_and_full_range_jumps(self):
        self.assertEqual([animation.quantize(v, 4) for v in (0, 42, 43, 127, 128, 212, 213, 255)],
                         [0, 0, 1, 1, 2, 2, 3, 3])
        value = 0
        actual = []
        for sample in (43, 48, 49, 42, 37, 36, 255, 0):
            value = animation.quantize(sample, 4, value, 6)
            actual.append(value)
        self.assertEqual(actual, [0, 0, 1, 1, 1, 0, 3, 0])
        self.assertEqual([animation.quantize(v, 2) for v in (0, 127, 128, 255)], [0, 0, 1, 1])

    def test_loading_old_binary_and_four_levels_rejects_bad_digits(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'movie.json'
            m = movie([frame()])
            path.write_text(json.dumps(m))
            self.assertEqual(animation.palette(animation.load_movie(path)), [0, 96])
            m.update(levels=4, frames=['0123'*70])
            path.write_text(json.dumps(m))
            self.assertEqual(animation.palette(animation.load_movie(path)), [0, 32, 64, 96])
            m['frames'] = ['0124'*70]
            path.write_text(json.dumps(m))
            with self.assertRaises(ValueError):
                animation.load_movie(path)

    def test_gray_coalescing_keeps_age_and_cancels_return_to_prediction(self):
        q = animation.ColorQueue([0]*280, animation.routing(False), animation.geometry())
        q.feed('1'+'0'*279, 1, .01)
        q.feed('2'+'0'*279, 2, .02)
        self.assertEqual(q.take(.03), (0, 2, .01, 2))
        q.feed('3'+'0'*279, 3, .03)
        q.feed('2'+'0'*279, 4, .04)
        self.assertFalse(q.pending)


class QueueTests(unittest.TestCase):
    def make_queue(self):
        return animation.ColorQueue([0]*280, animation.routing(False), animation.geometry())

    def test_age_then_center_and_board_preference(self):
        q = self.make_queue()
        q.feed(frame(0), 0, 0)
        q.feed(frame(0, 140), 1, .01)
        self.assertEqual(q.take(.02)[0], 0)  # Age outranks center.
        q.feed(frame(0, 1, 140), 2, .02)
        self.assertEqual(q.take(.03)[0], 140)  # Other board.
        q = self.make_queue()
        q.feed(frame(0, 140), 0, 0)
        self.assertEqual(q.take(0)[0], 140)  # Same-age center first.

    def test_cancel_and_reverse_inflight_prediction(self):
        q = self.make_queue()
        q.feed(frame(140), 0, 0)
        q.feed(frame(), 1, .01)
        self.assertFalse(q.pending)
        q.feed(frame(140), 2, .02)
        task = q.take(.02)  # White is now in flight, cannot be cancelled.
        self.assertEqual(task[:2], (140, 1))
        q.feed(frame(), 3, .03)
        self.assertEqual(q.take(.04)[:2], (140, 0))  # Queue compensating black.

    def test_pending_age_is_preserved_and_queue_is_bounded(self):
        q = self.make_queue()
        for f in range(100):
            q.feed('1'*280, f, f/30)
        self.assertEqual(len(q.pending), 280)
        self.assertTrue(all(p[1] == 0 for p in q.pending.values()))

    def test_age_never_overrides_board_alternation(self):
        q = self.make_queue()
        q.last_board = 1
        q.feed(frame(0), 0, 0)
        q.feed(frame(0, 56), 1, .05)
        self.assertEqual(q.take(10000)[0], 56)
        self.assertEqual(q.take(10001)[0], 0)  # Old key is immediately eligible again.

    def test_repeat_board_only_when_no_other_board_is_pending(self):
        q = self.make_queue()
        q.last_board = 1
        q.feed(frame(0, 1), 0, 0)
        self.assertIn(q.take(0)[0], (0, 1))
        self.assertIn(q.take(.01)[0], (0, 1))
        self.assertIsNone(q.take(.02))

    def test_routing_and_geometry(self):
        pts = animation.geometry()
        self.assertEqual(len(pts), 280)
        self.assertEqual(pts[139], [0, 0])
        self.assertEqual(animation.routing(True)[168], (5, 0))
        self.assertEqual(animation.routing(True)[224], (4, 0))
        self.assertEqual(set(animation.routing(True)), set(bench.ALL_KEYS))

    def test_simulation_keeps_video_clock_under_overload(self):
        m = movie([frame(), '1'*280, frame(), '1'*280, frame()])
        report, events, initial = animation.simulate(m, same_ms=100, other_ms=50)
        self.assertAlmostEqual(report['duration_s'], 5/30)
        self.assertLessEqual(report['peak_pending'], 280)
        self.assertLess(len(events), 10)
        self.assertGreater(report['cancelled'], 0)


class LightingDevice(Device):
    def __init__(self, out, failure=None):
        super().__init__(out, failure)
        self.lights = 1
        self.saw_lights_off = False
        self.sent_colors = []

    def send(self, msg):
        data = tuple(msg.data)
        if data[4] == 0x47:
            self.callback(message(bench.packet(0, 0x47, (1, 0, self.lights, 1, 0))))
        elif data[4] == 0x07:
            assert (self.out/'snapshot.json').exists()
            self.lights = data[5]
            self.saw_lights_off |= self.lights == 0
            self.callback(message(bench.packet(0, 7, (1,))))
        else:
            if data[4] == 1:
                self.sent_colors.append(tuple((data[i] << 4) | data[i+1] for i in (6, 8, 10)))
            super().send(msg)


class PlaybackTests(unittest.TestCase):
    def test_playback_and_preroll_failure_restore_colors_and_lighting(self):
        for levels, failure in ((levels, failure) for levels in (2, 4)
                                for failure in (None, 'nack', 'timeout', 'interrupt')):
            with self.subTest(levels=levels, failure=failure), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)/'movie.json'
                m = movie([frame(), frame(140, 141, 56), frame()])
                if levels == 4:
                    m.update(levels=4, frames=['0123'*70, '3210'*70, '0123'*70])
                path.write_text(json.dumps(m))
                out = Path(directory)/'run'
                device = LightingDevice(out, failure)
                args = ['bench.py', '--animation', str(path), '--out', str(out),
                        '--timeout', '.01', '--swap-boards-34']
                with patch.object(sys, 'argv', args), patch.dict(sys.modules, mido=device.module()), \
                        patch('signal.signal', side_effect=lambda s, f: device.signals.__setitem__(s, f)), \
                        redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    result = bench.main()
                report = json.loads((out/'report.json').read_text())
                self.assertEqual(result, 0 if failure is None else 130 if failure == 'interrupt' else 1)
                self.assertTrue(report['restored'])
                self.assertTrue(report['lighting_restored'])
                self.assertEqual(device.colors, device.original)
                self.assertTrue(device.saw_lights_off)
                self.assertEqual(device.lights, 1)
                if failure is None:
                    self.assertTrue(report['animation']['readback_verified'])
                    self.assertTrue((out/'replay.html').exists())
                    expected = [0, 96] if levels == 2 else [0, 32, 64, 96]
                    self.assertEqual(report['animation']['rgb_channel_palette'], expected)
                    self.assertEqual(set(device.sent_colors) - {(17, 34, 51)},
                                     {(v, v, v) for v in expected})


if __name__ == '__main__':
    unittest.main()
