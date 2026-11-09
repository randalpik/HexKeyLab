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
        task = q.take(.02)  # White is now in flight, cannot be canceled.
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
        self.assertGreater(report['canceled'], 0)


def gray_movie(frames, fps=30):
    return {'format': animation.FORMAT, 'fps': fps, 'levels': animation.GRAY, 'frames': frames,
            'points': animation.geometry(), 'mapping': {'vertical_scale': .75}}


class GrayFrameTests(unittest.TestCase):
    def test_gray_movies_load_and_reject_bad_frames(self):
        good = gray_movie([bytes(i % 256 for i in range(280)).hex()])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'m.json'
            path.write_text(json.dumps(good))
            self.assertEqual(animation.gray_frame(animation.load_movie(path), 0)[:3], [0, 1, 2])
            for bad in ('zz' * 280, '00' * 279, '0' * 280):
                path.write_text(json.dumps(gray_movie([bad])))
                with self.assertRaises(ValueError):
                    animation.load_movie(path)

    def test_led_levels_scale_white_and_gamma(self):
        self.assertEqual(animation.led_levels([0, 255], 254, 2.2), [0, 127])
        self.assertEqual(animation.led_levels(list(range(0, 256, 2)), 254, 1), list(range(128)))
        curved = animation.led_levels(list(range(256)), 254, 2.2)
        self.assertEqual(curved, sorted(curved))
        self.assertLess(curved[128], 64)  # mid-gray sits below half power
        self.assertEqual(animation.led_levels([255], 96, 1), [48])
        self.assertEqual(animation.gray_frame(movie([frame(3)]), 0)[2:5], [0, 255, 0])


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

    def run_frames(self, m, failure=None, extra=(), delay=0):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'movie.json'
            path.write_text(json.dumps(m))
            out = Path(directory)/'run'
            device = LightingDevice(out, failure)
            device.firmware = (1, 5, 0)
            device.frame_delay = delay
            args = ['bench.py', '--animation', str(path), '--out', str(out), '--timeout', '.2',
                    '--swap-boards-34', '--white', '254', *extra]
            with patch.object(sys, 'argv', args), patch.dict(sys.modules, mido=device.module()), \
                    patch('signal.signal', side_effect=lambda s, f: device.signals.__setitem__(s, f)), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = bench.main()
            return result, device, json.loads((out/'report.json').read_text())

    def test_gray_frames_play_route_verify_and_restore(self):
        f0 = bytes(280).hex()
        f1 = bytes(255 if i == 168 else 0 for i in range(280)).hex()  # logical key 168
        for failure in (None, 'nack', 'timeout', 'interrupt'):
            with self.subTest(failure=failure):
                result, device, report = self.run_frames(gray_movie([f0, f1, f0, f1, f0]), failure)
                self.assertEqual(result, 0 if failure is None else 130 if failure == 'interrupt' else 1)
                self.assertTrue(report['restored'])
                self.assertTrue(report['lighting_restored'])
                self.assertEqual(device.colors, device.original)
                self.assertTrue(device.saw_lights_off)
                if failure is None:
                    a = report['animation']
                    self.assertEqual(a['mode'], 'hardware-55h-frames')
                    self.assertTrue(a['readback_verified'])
                    self.assertGreaterEqual(device.frames, 2)
                    self.assertEqual(a['frames_sent'] + 1, device.frames)  # + preroll
                    self.assertEqual(a['distinct_led_levels'], 2)

    def test_frames_flag_plays_digit_movies_as_frames(self):
        result, device, report = self.run_frames(movie([frame(), frame(140), frame()]), extra=('--frames',))
        self.assertEqual(result, 0)
        self.assertEqual(report['animation']['mode'], 'hardware-55h-frames')
        self.assertEqual(device.colors, device.original)

    def test_slow_device_drops_frames_and_keeps_the_video_clock(self):
        frames = [bytes([i * 9 % 256] * 280).hex() for i in range(24)]
        result, device, report = self.run_frames(gray_movie(frames, fps=120), delay=.03)
        a = report['animation']
        self.assertEqual(result, 0)
        self.assertGreater(a['frames_dropped'], 0)
        self.assertLess(a['frames_sent'], len(frames))
        self.assertLess(a['duration_s'], .3)


if __name__ == '__main__':
    unittest.main()
