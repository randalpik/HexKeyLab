#!/usr/bin/env python3
"""Video conversion, bounded color scheduling, simulation and hex replay."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import time

from bench import color_packet, distribution, write_json

ROOT = Path(__file__).resolve().parents[2]
FORMAT = 'hkl-lumatone-animation-v1'


def palette(movie, white=96):
    levels = movie.get('levels', 2)
    return [round(i * white / (levels - 1)) for i in range(levels)]


def quantize(value, levels, previous=None, hysteresis=0, threshold=128):
    boundaries = [threshold] if levels == 2 else [42.5, 127.5, 212.5]
    if previous is None:
        return sum(value >= boundary for boundary in boundaries)
    result = previous
    while result < levels - 1 and value >= boundaries[result] + hysteresis:
        result += 1
    while result > 0 and value < boundaries[result - 1] - hysteresis:
        result -= 1
    return result


def geometry():
    source = (ROOT / 'apps/hkl/src/layout/baseKeys.ts').read_text()
    coords = json.loads(re.search(r'= (\[\[.*\]\]);', source).group(1))
    angle = math.atan(1.54 / (3 * 1.78))
    c, s = math.cos(angle), math.sin(angle)
    points = []
    for q, r in coords:
        x, y = (q + r / 2) * 1.78, r * 1.54
        points.append([x * c - y * s, -(x * s + y * c)])
    return points


def routing(swap):
    # Same logical-group mapping as HKL protocol.ts. MIDI channels are unrelated.
    boards = [1, 2, 3, 5, 4] if swap else [1, 2, 3, 4, 5]
    return [(boards[i // 56], i % 56) for i in range(280)]


def load_movie(path):
    movie = json.loads(Path(path).read_text())
    if movie.get('format') != FORMAT:
        raise ValueError('Unsupported animation format')
    fps = movie['fps']
    if not isinstance(fps, (int, float)) or not math.isfinite(fps) or not 0 < fps <= 120:
        raise ValueError('Invalid animation FPS')
    levels = movie.get('levels', 2)  # Existing binary files omit this field.
    if type(levels) is not int or levels not in (2, 4):
        raise ValueError('Animation levels must be 2 or 4')
    digits = set(map(str, range(levels)))
    if (not movie['frames'] or any(len(f) != 280 or set(f) - digits for f in movie['frames'])
            or len(movie['points']) != 280
            or any(len(p) != 2 or any(not math.isfinite(v) for v in p) for p in movie['points'])):
        raise ValueError('Invalid animation frames/geometry')
    return movie


class ColorQueue:
    """One unsent target/key. Ages track continuous divergence from predicted state."""
    def __init__(self, initial, addresses, points):
        self.predicted = list(initial)
        self.addresses = addresses
        self.distance = [x*x + y*y for x, y in points]
        self.pending = {}  # key -> (latest level, first-outstanding time, latest frame)
        self.last_board = None
        self.cancelled = 0
        self.coalesced = 0
        self.peak = 0

    def feed(self, frame, index, timestamp):
        for key, char in enumerate(frame):
            value = int(char)
            old = self.pending.get(key)
            if value == self.predicted[key]:
                if old is not None:
                    del self.pending[key]
                    self.cancelled += 1
            elif old is None:
                self.pending[key] = (value, timestamp, index)
            else:
                self.coalesced += old[0] != value
                self.pending[key] = (value, old[1], index)
        self.peak = max(self.peak, len(self.pending))

    def take(self, now):
        if not self.pending:
            return None
        rank = lambda k: (self.pending[k][1], self.distance[k], k)
        other = [k for k in self.pending if self.addresses[k][0] != self.last_board]
        # Board alternation is unconditional when useful other-board work exists.
        key = min(other if other else self.pending, key=rank)
        value, since, frame = self.pending.pop(key)
        self.predicted[key] = value  # Fold in-flight intent into subsequent diffs.
        self.last_board = self.addresses[key][0]
        return key, value, since, frame


def analyze(movie, events, initial, duration):
    actual = list(initial)
    cursor = 0
    errors = []
    brightness_errors = []
    demand = 0
    frames = movie['frames'][:math.ceil(duration * movie['fps'])]
    for index, frame in enumerate(frames):
        timestamp = index / movie['fps']
        while cursor < len(events) and events[cursor][0] <= timestamp:
            _, key, value, *_ = events[cursor]
            actual[key] = value
            cursor += 1
        errors.append(sum(v != int(c) for v, c in zip(actual, frame)))
        brightness_errors.append(sum(abs(v - int(c)) for v, c in zip(actual, frame))
                                 / (280 * (movie.get('levels', 2) - 1)))
        if index:
            demand += sum(a != b for a, b in zip(frame, frames[index - 1]))
    return {'duration_s': duration, 'acked': len(events), 'levels': movie.get('levels', 2),
            'updates_per_s': len(events) / duration if duration else 0,
            'source_changes_per_s': demand / duration if duration else 0,
            'mismatched_keys_at_frame_boundary': distribution(errors),
            'mean_matching_fraction': 1 - sum(errors) / (280 * len(errors)) if errors else 1,
            'mean_absolute_brightness_error_fraction': (sum(brightness_errors) / len(brightness_errors)
                                                        if brightness_errors else 0),
            'outstanding_age_at_ack_ms': distribution([e[3] * 1000 for e in events])}


def simulate(movie, same_ms=8.2, other_ms=3.1, duration=None):
    duration = min(duration or math.inf, len(movie['frames']) / movie['fps'])
    initial = list(map(int, movie['frames'][0]))
    scheduler = ColorQueue(initial, routing(False), movie['points'])
    events = []
    frame = 0
    now = 0.
    flight = None
    ack_time = math.inf
    while now < duration:
        # Complete ACK first at exact ties, then deliver every due frame.
        if flight is not None and ack_time <= now:
            key, value, since, source_frame = flight
            events.append([now, key, value, now - since, source_frame])
            flight = None
        while frame < len(movie['frames']) and frame / movie['fps'] <= now:
            scheduler.feed(movie['frames'][frame], frame, frame / movie['fps'])
            frame += 1
        if flight is None:
            previous_board = scheduler.last_board
            flight = scheduler.take(now)
            if flight is not None:
                board = scheduler.addresses[flight[0]][0]
                ack_time = now + (same_ms if board == previous_board else other_ms) / 1000
        next_frame = frame / movie['fps'] if frame < len(movie['frames']) else math.inf
        now = min(next_frame, ack_time if flight is not None else math.inf, duration)
    report = analyze(movie, events, initial, duration)
    report.update(mode='simulation', same_board_ms=same_ms, different_board_ms=other_ms,
                  board_policy='always-alternate-when-pending', cancelled=scheduler.cancelled,
                  peak_pending=scheduler.peak)
    return report, events, initial


def play(client, movie, state, args, stopped, report, out):
    addresses = routing(args.swap_boards_34)
    intensities = palette(movie, args.white)
    initial = list(map(int, movie['frames'][0]))
    # Frame zero is fully initialized before the playback clock starts.
    client.phase = client.run_id = 'animation-preroll'
    scheduler = ColorQueue([-1] * 280, addresses, movie['points'])
    for i, address in enumerate(addresses):
        wanted = (intensities[initial[i]],) * 3
        scheduler.predicted[i] = initial[i] if state[address] == wanted else -1
    scheduler.feed(movie['frames'][0], 0, 0)
    while scheduler.pending and not stopped():
        key, value, *_ = scheduler.take(0)
        rgb = (intensities[value],) * 3
        client.exchange(color_packet(*addresses[key], rgb))
        state[addresses[key]] = rgb
    if stopped():
        return
    client.verify(state)
    duration = min(args.duration or math.inf, len(movie['frames']) / movie['fps'])
    scheduler = ColorQueue(initial, addresses, movie['points'])
    frame = 0
    events = []
    client.phase = client.run_id = 'animation'
    start = time.perf_counter()
    next_progress = 5
    try:
        while not stopped():
            now = time.perf_counter() - start
            if now >= duration:
                break
            while frame < len(movie['frames']) and frame / movie['fps'] <= now:
                scheduler.feed(movie['frames'][frame], frame, frame / movie['fps'])
                frame += 1
            task = scheduler.take(now)
            if task is None:
                time.sleep(min(.005, max(0, frame / movie['fps'] - now)))
                continue
            key, value, since, source_frame = task
            rgb = (intensities[value],) * 3
            client.exchange(color_packet(*addresses[key], rgb))
            ack = client.rows[-1]['received_ns'] / 1e9 - start
            state[addresses[key]] = rgb
            events.append([ack, key, value, ack - since, source_frame])
            if now >= next_progress:
                print(f'  {now:.1f}/{duration:.1f}s: {len(events)/now:.1f} updates/s, '
                      f'{len(scheduler.pending)} pending', flush=True)
                next_progress = now + 5
    finally:
        elapsed = min(time.perf_counter() - start, duration)
        report['animation'] = analyze(movie, events, initial, elapsed)
        report['animation'].update(mode='hardware', cancelled=scheduler.cancelled,
                                   peak_pending=scheduler.peak, board_policy='always-alternate-when-pending',
                                   swap_boards_34=args.swap_boards_34,
                                   rgb_channel_palette=intensities,
                                   movie_sha256=hashlib.sha256(args.animation.read_bytes()).hexdigest())
        write_json(out / 'animation-trace.json', {'events': events, 'initial': initial})
        preview(out / 'replay.html', movie, events, initial, elapsed, 'ACK-tracked device replay')
    client.phase = 'animation:verify'
    client.verify(state)
    report['animation']['readback_verified'] = True


def preview(path, movie, events=None, initial=None, duration=None, label='Target geometry'):
    data = dict(movie=movie, events=events or [], has_trace=events is not None,
                initial=initial if initial is not None else list(map(int, movie['frames'][0])),
                duration=duration or len(movie['frames']) / movie['fps'], label=label)
    template = (Path(__file__).parent / 'replay.html').read_text()
    path.write_text(template.replace('/*DATA*/null', json.dumps(data).replace('<', '\\u003c')))


def convert(args):
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,sample_aspect_ratio:format=duration', '-of', 'json', str(args.video)]))
    stream = info['streams'][0]
    width = 320
    sar = stream.get('sample_aspect_ratio', '1:1')
    n, d = (map(int, sar.split(':')) if sar not in ('N/A', '0:1') else (1, 1))
    height = max(1, round(width * stream['height'] / (stream['width'] * n / d)))
    points = geometry()
    xmin, xmax = min(x for x, y in points)-1, max(x for x, y in points)+1
    scale = (xmax-xmin) / width * args.zoom
    radius = max(1, round(.45 / scale))
    samples = []
    for x, y in points:
        px = width/2 + (x-(xmin+xmax)/2) / scale
        py = height/2 + y / (scale * args.vertical_scale) + args.y_offset * height
        # Box average a small key footprint, then quantize; no temporal dithering.
        samples.append([(round(py)+dy)*width + round(px)+dx
                        for dy in range(-radius, radius+1) for dx in range(-radius, radius+1)
                        if 0 <= round(px)+dx < width and 0 <= round(py)+dy < height])
    cmd = ['ffmpeg', '-v', 'error', '-i', str(args.video), '-an', '-vf',
           f'fps={args.fps},scale={width}:{height}:flags=area,format=gray', '-f', 'rawvideo', '-']
    frames = []
    with subprocess.Popen(cmd, stdout=subprocess.PIPE) as process:
        while True:
            raw = process.stdout.read(width*height)
            if not raw:
                break
            if len(raw) != width*height:
                raise RuntimeError('Truncated decoded video frame')
            previous = list(map(int, frames[-1])) if frames else [None] * 280
            frames.append(''.join(str(quantize(
                sum(raw[i] for i in sample)/len(sample) if sample else 0,
                args.levels, previous[key], args.hysteresis, args.threshold))
                for key, sample in enumerate(samples)))
        if process.wait() != 0:
            raise RuntimeError('Video decode failed')
    if not frames:
        raise ValueError('Video contains no frames')
    movie = {'format': FORMAT, 'fps': args.fps, 'levels': args.levels, 'points': points, 'frames': frames,
             'source': str(args.video), 'source_sha256': hashlib.sha256(args.video.read_bytes()).hexdigest(),
             'mapping': {'vertical_scale': args.vertical_scale, 'zoom': args.zoom,
                         'y_offset': args.y_offset,
                         'threshold': args.threshold if args.levels == 2 else None,
                         'hysteresis': args.hysteresis,
                         'orientation': 'lumatone', 'order': 'HKL baseKeys logical physical index'}}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.out, movie)
    preview(args.out.with_suffix('.html'), movie)
    print(f'{len(frames)} frames, {len(frames)/args.fps:.2f}s -> {args.out}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    conv = sub.add_parser('convert')
    conv.add_argument('video', type=Path)
    conv.add_argument('--out', type=Path, required=True)
    conv.add_argument('--fps', type=float, default=30)
    conv.add_argument('--vertical-scale', type=float, default=.75)
    conv.add_argument('--zoom', type=float, default=1)
    conv.add_argument('--y-offset', type=float, default=0, help='Source-height fraction; positive samples lower')
    conv.add_argument('--threshold', type=float, default=128)
    conv.add_argument('--levels', type=int, choices=(2, 4), default=2)
    conv.add_argument('--hysteresis', type=float,
                      help='Source-gray threshold margin, 0–42; default 6 for four levels, otherwise 0')
    sim = sub.add_parser('simulate')
    sim.add_argument('movie', type=Path)
    sim.add_argument('--out', type=Path, required=True)
    sim.add_argument('--same-ms', type=float, default=8.2)
    sim.add_argument('--other-ms', type=float, default=3.1)
    args = parser.parse_args()
    numeric = [v for v in vars(args).values() if isinstance(v, float)]
    if not all(math.isfinite(v) for v in numeric):
        parser.error('Numeric options must be finite')
    if args.command == 'convert':
        if args.hysteresis is None:
            args.hysteresis = 6 if args.levels == 4 else 0
        if not 0 < args.fps <= 120 or args.vertical_scale <= 0 or args.zoom <= 0 or not 0 <= args.threshold <= 255:
            parser.error('Invalid FPS, scale, zoom or threshold')
        if not 0 <= args.hysteresis <= 42:
            parser.error('Hysteresis must be between 0 and 42')
        if args.levels == 4 and args.threshold != 128:
            parser.error('--threshold applies only to two-level conversion')
        convert(args)
    else:
        if min(args.same_ms, args.other_ms) <= 0:
            parser.error('Latencies must be positive')
        movie = load_movie(args.movie)
        report, events, initial = simulate(movie, args.same_ms, args.other_ms)
        args.out.mkdir(parents=True, exist_ok=False)
        write_json(args.out / 'report.json', report)
        write_json(args.out / 'trace.json', {'initial': initial, 'events': events})
        preview(args.out / 'replay.html', movie, events, initial, report['duration_s'], 'Simulated device')
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
