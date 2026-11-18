#!/usr/bin/env python3
# keydata-compare — compare saved calibration folders, one per run of the
# built-in key calibration, and report how repeatable the learned values are.
#
# Usage:
#   python3 keydata-compare.py [--swap-boards-34] [--top N] [--level L]
#                              [--write DIR] [--maps DIR] <run-dir> [<run-dir> ...]
#
# Each <run-dir> holds KeyData_1..5 and ThresholdData_1..5: a folder made by
# `keydata-backup.sh save` right after a confirmed calibration. Give them in
# the order they were taken. One folder is enough for the window and sibling
# sections; the repeatability sections need two or more.
#
#   --swap-boards-34   the unit has boards 3 and 4 physically swapped (HKL's
#                      "Swap boards 3 <-> 4"); only the (q, r) labels and the
#                      maps depend on it
#   --top N            rows per ranked list (default 12)
#   --level L          combine the runs with each run's overall level (its
#                      mean MAX) removed, and place the result at level L: run
#                      labels such as R3,R4 (the mean of those runs' levels) or
#                      a number. How firmly the keys were pressed moves a whole
#                      run up or down, so this separates the key-to-key pattern
#                      (taken from every run) from the level (chosen). Without
#                      it the median is taken over the values as stored.
#   --write DIR        write a folder whose MAX and MIN rows are the per-key
#                      medians over the runs (see --level); the validity and
#                      AT-MAX rows and the ThresholdData files are copied from
#                      the last run.
#                      Check it with `keydata-backup.sh check DIR`, write it to
#                      the device with `keydata-backup.sh restore DIR`.
#   --maps DIR         draw the keyboard maps as PNG files (needs matplotlib):
#                      window.png, siblings.png and, with two or more runs,
#                      spread.png
#
# What the numbers mean (docs/lessons.md, "What the key routine stores"): the
# built-in routine stores each key's highest sensor reading as MAX and its rest
# reading as MIN. In play the press timer starts at MIN + the board's `min lo`
# and the note-on fires above MAX - the board's `max` (ThresholdData rows 4 and
# 1), so a key's timing window is MAX - MIN - (max + min lo) sensor counts. A
# shorter window reads louder at the same touch.
#
# Nothing here talks to the device.

import importlib.util
import math
import os
import shutil
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS_PER_BOARD = 56
BOARDS = (1, 2, 3, 4, 5)        # PIC / SysEx board = KeyData_N


def load_base_keys():
    """The 280-key (q, r) table lives in keydata-locate.py (its copy of baseKeys.ts)."""
    spec = importlib.util.spec_from_file_location('keydata_locate', os.path.join(HERE, 'keydata-locate.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.BASE_KEYS, mod.SYSEX_BOARD_MAP, mod.SWAPPED_BOARD_MAP


def read_rows(path, rows, per):
    if not os.path.isfile(path):
        sys.exit('missing: {0}'.format(path))
    with open(path) as f:
        out = [[int(v) for v in line.strip().rstrip(',').split(',')] for line in f if line.strip()]
    if len(out) != rows or any(len(r) != per for r in out):
        sys.exit('{0}: expected {1} rows of {2} values (run keydata-backup.sh check)'.format(path, rows, per))
    return out


def load_run(d):
    """→ {board: {'max': [56], 'min': [56], 'valid': [56], 'atmax': [56], 'overhead': int}}"""
    run = {}
    for b in BOARDS:
        kd = read_rows(os.path.join(d, 'KeyData_{0}'.format(b)), 4, KEYS_PER_BOARD)
        th = read_rows(os.path.join(d, 'ThresholdData_{0}'.format(b)), 10, 1)
        # ThresholdData rows: max, AT max, min hi, min lo, ...
        run[b] = {'max': kd[0], 'min': kd[1], 'valid': kd[2], 'atmax': kd[3],
                  'overhead': th[0][0] + th[3][0]}
    return run


def median_int(values):
    """Median as an integer; an even count takes the mean of the middle two, half rounded up."""
    return int(math.floor(st.median(values) + 0.5))


def percentile(sorted_vals, p):
    return sorted_vals[min(len(sorted_vals) - 1, int(p * len(sorted_vals)))]


def correlation(a, b):
    ma, mb = st.mean(a), st.mean(b)
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / den if den else float('nan')


def run_levels(runs):
    """Each run's overall level: its mean MAX over the 280 keys. How firmly the
    keys were pressed moves a whole run up or down by several counts."""
    return [st.mean(v for b in BOARDS for v in run[b]['max']) for run in runs]


def parse_level(text, runs):
    """--level: run labels (R3,R4 → the mean of those runs' levels) or a number."""
    levels = run_levels(runs)
    if text.upper().startswith('R'):
        try:
            picked = [levels[int(t[1:]) - 1] for t in text.upper().split(',') if t[:1] == 'R' and int(t[1:]) >= 1]
        except (ValueError, IndexError):
            picked = []
        if not picked or len(picked) != len(text.split(',')):
            sys.exit('--level: expected run labels R1..R{0} or a number, got {1}'.format(len(runs), text))
        return st.mean(picked)
    try:
        return float(text)
    except ValueError:
        sys.exit('--level: expected run labels R1..R{0} or a number, got {1}'.format(len(runs), text))


def build_keys(runs, base_keys, board_map, target_level=None):
    """One record per key, with its values in every run and the median-based figures.
    With a target level, MAX is the median of the level-removed values placed there."""
    group_of = {pic: g for g, pic in enumerate(board_map)}      # PIC board → spatial group 0..4
    last = runs[-1]
    levels = run_levels(runs)
    base_level = st.mean(levels)
    keys = []
    for b in BOARDS:
        for k in range(KEYS_PER_BOARD):
            q, r = base_keys[group_of[b] * KEYS_PER_BOARD + k]
            maxes = [run[b]['max'][k] for run in runs]
            mins = [run[b]['min'][k] for run in runs]
            med_max, med_min = median_int(maxes), median_int(mins)
            # the same values with each run moved to the runs' common level
            leveled = [m - (lv - base_level) for m, lv in zip(maxes, levels)]
            if target_level is not None:
                placed = st.median(m - lv for m, lv in zip(maxes, levels)) + target_level
                med_max = max(0, min(254, int(math.floor(placed + 0.5))))
            keys.append({
                'leveled': leveled, 'spread_leveled': max(leveled) - min(leveled),
                'pic': b, 'slot': k, 'board': group_of[b] + 1, 'q': q, 'r': r,
                'maxes': maxes, 'mins': mins, 'max': med_max, 'min': med_min,
                'spread': max(maxes) - min(maxes),
                'window': med_max - med_min - last[b]['overhead'],
            })
    by = {(x['pic'], x['slot']): x for x in keys}
    for x in keys:
        sib = sorted(by[(o, x['slot'])]['window'] for o in BOARDS if o != x['pic'])
        x['siblings'] = sib
        x['dev'] = x['window'] - st.median(sib)
    return keys


def key_label(x):
    return 'board {0}  ({1:>3},{2:>3})  KeyData_{3}, slot {4:>2}'.format(x['board'], x['q'], x['r'], x['pic'], x['slot'])


def report(names, runs, keys, top, target_level=None):
    n = len(runs)
    print('Runs ({0}):'.format(n))
    for i, (name, run) in enumerate(zip(names, runs)):
        maxes = sorted(v for b in BOARDS for v in run[b]['max'])
        mins = [v for b in BOARDS for v in run[b]['min']]
        valid = sum(v for b in BOARDS for v in run[b]['valid'])
        over = sorted(set(run[b]['overhead'] for b in BOARDS))
        print('  R{0}  {1}'.format(i + 1, name))
        print('      MAX {0}..{1}, median {2};  MIN 0..{3}, {4} keys at 0;  valid {5}/280;  max + min lo = {6}'.format(
            maxes[0], maxes[-1], st.median(maxes), max(mins), mins.count(0), valid, '/'.join(map(str, over))))

    if n >= 2:
        print('\nRepeatability of MAX across runs:')
        levels = run_levels(runs)
        print('  overall level of each run (mean MAX): {0}'.format(
            ', '.join('R{0} {1:.1f}'.format(i + 1, lv) for i, lv in enumerate(levels))))
        spreads = sorted(x['spread'] for x in keys)
        print('  per-key spread as stored (largest - smallest): median {0}, 90th percentile {1}, largest {2}'.format(
            st.median(spreads), percentile(spreads, 0.9), spreads[-1]))
        leveled = sorted(x['spread_leveled'] for x in keys)
        print('  per-key spread with each run\'s level removed:  median {0:.1f}, 90th percentile {1:.1f}, largest {2:.1f}'.format(
            st.median(leveled), percentile(leveled, 0.9), leveled[-1]))
        print('    keys with that spread >= 5: {0};  >= 10: {1};  >= 15: {2}'.format(
            sum(s >= 5 for s in leveled), sum(s >= 10 for s in leveled), sum(s >= 15 for s in leveled)))
        within = st.mean(st.variance(x['leveled']) for x in keys)
        means = [st.mean(x['leveled']) for x in keys]
        between = max(0.0, st.pvariance(means) - within / n)
        share = between / (between + within) if between + within else float('nan')
        print('  level removed: run-to-run sd within a key {0:.1f} counts;  sd between keys {1:.1f};  repeatable share of the variance {2:.0f}%'.format(
            math.sqrt(within), math.sqrt(between), 100 * share))
        print('  run pairs (correlation of MAX over the 280 keys, mean difference later - earlier):')
        for i in range(n):
            for j in range(i + 1, n):
                a = [x['maxes'][i] for x in keys]
                b = [x['maxes'][j] for x in keys]
                print('    R{0}-R{1}: r = {2:.2f}, {3:+.1f} counts'.format(i + 1, j + 1, correlation(a, b), st.mean(b) - st.mean(a)))
        rest = sorted(max(x['mins']) - min(x['mins']) for x in keys)
        print('  rest reading (MIN) spread: median {0}, largest {1}'.format(st.median(rest), rest[-1]))

        print('\nLeast repeatable keys (MAX in each run as stored; spread with the run levels removed):')
        for x in sorted(keys, key=lambda x: -x['spread_leveled'])[:top]:
            print('  {0}   {1}   median {2:>3}  spread {3:.1f}'.format(
                key_label(x), ' '.join('{0:>3}'.format(v) for v in x['maxes']), x['max'], x['spread_leveled']))
    else:
        print('\n(one run: no repeatability figures; give two or more folders for them)')

    which = 'median over the runs' if n >= 2 else 'this run'
    if target_level is not None:
        which = 'median of the level-removed runs, placed at level {0:.1f}'.format(target_level)
    windows = sorted(x['window'] for x in keys)
    print('\nTiming window, {0} (MAX - MIN - (max + min lo)): {1}..{2}, median {3}'.format(
        which, windows[0], windows[-1], st.median(windows)))
    print('Smallest windows (predicted loudest):')
    for x in sorted(keys, key=lambda x: x['window'])[:top]:
        print('  {0}   MAX {1:>3}  MIN {2}  window {3:>3}'.format(key_label(x), x['max'], x['min'], x['window']))

    print('\nWindow against the same slot on the other four boards (window - their median):')
    print(' shorter than its siblings (predicted louder):')
    for x in sorted(keys, key=lambda x: x['dev'])[:top]:
        print('  {0}   window {1:>3}  siblings {2}  {3:+.1f}'.format(
            key_label(x), x['window'], ' '.join('{0:>2}'.format(v) for v in x['siblings']), x['dev']))
    print(' longer than its siblings (predicted quieter):')
    for x in sorted(keys, key=lambda x: -x['dev'])[:top]:
        print('  {0}   window {1:>3}  siblings {2}  {3:+.1f}'.format(
            key_label(x), x['window'], ' '.join('{0:>2}'.format(v) for v in x['siblings']), x['dev']))


def write_median(out_dir, last_dir, runs, keys, target_level=None):
    if os.path.exists(out_dir) and os.listdir(out_dir):
        sys.exit('--write: {0} exists and is not empty'.format(out_dir))
    os.makedirs(out_dir, exist_ok=True)
    by = {(x['pic'], x['slot']): x for x in keys}
    last = runs[-1]
    for b in BOARDS:
        rows = [
            [by[(b, k)]['max'] for k in range(KEYS_PER_BOARD)],
            [by[(b, k)]['min'] for k in range(KEYS_PER_BOARD)],
            last[b]['valid'],
            last[b]['atmax'],
        ]
        with open(os.path.join(out_dir, 'KeyData_{0}'.format(b)), 'w') as f:
            f.write('\n'.join(','.join(str(v) for v in row) for row in rows) + '\n')
        shutil.copyfile(os.path.join(last_dir, 'ThresholdData_{0}'.format(b)),
                        os.path.join(out_dir, 'ThresholdData_{0}'.format(b)))
    print('\nwrote the median of {0} run(s) to {1}'.format(len(runs), out_dir))
    levels = run_levels(runs)
    if target_level is not None:
        print('  MAX: median of the level-removed runs, placed at level {0:.1f}'.format(target_level))
    elif max(levels) - min(levels) >= 3:
        print('  note: the runs differ in overall level by {0:.1f} counts, so the plain median mostly follows the middle run (see --level)'.format(
            max(levels) - min(levels)))
    print('  MAX and MIN rows: per-key medians; validity, AT-MAX and ThresholdData: from the last run')
    print('  next: keydata-backup.sh check {0}'.format(out_dir))


def draw_maps(out_dir, keys, n_runs, overhead_text, target_level=None):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from matplotlib.colors import LinearSegmentedColormap, Normalize, TwoSlopeNorm
        from matplotlib.patches import RegularPolygon
    except ImportError:
        sys.exit('--maps needs matplotlib')
    os.makedirs(out_dir, exist_ok=True)
    # HKL's lattice → screen mapping in its Lumatone rotation
    # (apps/hkl/src/layout/geometry.ts: hexToScreen, dxH, dyH, caseLevelTilt).
    dx, dy = 1.78, 1.54
    tilt = math.atan(dy / (3 * dx))
    cos_t, sin_t = math.cos(tilt), math.sin(tilt)

    def pos(q, r):
        x, y = (q + r * 0.5) * dx, r * dy
        return x * cos_t - y * sin_t, x * sin_t + y * cos_t

    ink = '#1b1f24'

    def draw(name, value, cmap, norm, fmt, ringed, ring_color, title, bar_label):
        fig, ax = plt.subplots(figsize=(22, 9.5), dpi=110)
        fig.patch.set_facecolor('white')
        for x in keys:
            px, py = pos(x['q'], x['r'])
            v = value(x)
            rgba = cmap(norm(v))
            ax.add_patch(RegularPolygon((px, py), 6, radius=0.98, orientation=tilt,
                                        facecolor=rgba, edgecolor='white', lw=1.5))
            if ringed(x):
                ax.add_patch(RegularPolygon((px, py), 6, radius=0.90, orientation=tilt,
                                            facecolor='none', edgecolor=ring_color, lw=2.8))
            luminance = 0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]
            text = 'white' if luminance < 0.45 else ink
            ax.text(px, py + 0.18, fmt(v), ha='center', va='center', fontsize=10.5, color=text, fontweight='bold')
            ax.text(px, py - 0.42, '{0},{1}'.format(x['q'], x['r']), ha='center', va='center',
                    fontsize=6.5, color=text, alpha=0.85)
        for board in range(1, 6):
            ks = [x for x in keys if x['board'] == board]
            pts = [pos(x['q'], x['r']) for x in ks]
            ax.text(sum(p[0] for p in pts) / len(pts), max(p[1] for p in pts) + 1.5,
                    'Board {0}  (PIC {1}, KeyData_{1})'.format(board, ks[0]['pic']),
                    ha='center', fontsize=12, color=ink)
        ax.set_aspect('equal')
        ax.autoscale_view()
        ax.margins(0.02)
        ax.axis('off')
        ax.set_title(title, fontsize=13, color=ink, loc='left', pad=34)
        bar = fig.colorbar(plt.cm.ScalarMappable(norm=norm, cmap=cmap), ax=ax, fraction=0.018, pad=0.01)
        bar.set_label(bar_label)
        bar.outline.set_visible(False)
        path = os.path.join(out_dir, name)
        fig.savefig(path, bbox_inches='tight', facecolor='white')
        plt.close(fig)
        print('  ' + path)

    source = 'median of {0} runs'.format(n_runs) if n_runs >= 2 else 'one run'
    if target_level is not None:
        source = 'median of {0} level-removed runs at level {1:.1f}'.format(n_runs, target_level)
    sequential = LinearSegmentedColormap.from_list('window', ['#0b2a4a', '#1f5f99', '#6fa8d6', '#cfe1f2', '#f3f7fb'])
    diverging = LinearSegmentedColormap.from_list(
        'siblings', ['#0b2a4a', '#1f5f99', '#8fb8dc', '#ececec', '#e8b48a', '#c0621f', '#6b2f08'])
    spread_map = LinearSegmentedColormap.from_list('spread', ['#f3f7fb', '#cfe1f2', '#6fa8d6', '#1f5f99', '#0b2a4a'])
    windows = sorted(x['window'] for x in keys)
    low = windows[11]                       # the 12 smallest windows are ringed
    print('\nmaps:')
    draw('window.png', lambda x: x['window'], sequential,
         Normalize(vmin=windows[0], vmax=percentile(windows, 0.97), clip=True),
         lambda v: str(v), lambda x: x['window'] <= low, '#d1442b',
         'Velocity timing window per key, in sensor counts (MAX − MIN − {0}), {1}\n'
         'Darker = shorter window = louder at the same touch.  Red ring = the smallest ({2} or less).  '
         'Small text = HKL (q, r).  Median key = {3}.'.format(overhead_text, source, low, st.median(windows)),
         'window (counts)')
    draw('siblings.png', lambda x: x['dev'], diverging,
         TwoSlopeNorm(vmin=-26, vcenter=0, vmax=26),
         lambda v: '{0:+d}'.format(int(math.floor(v + 0.5))), lambda x: abs(x['dev']) >= 12, '#111111',
         'Each key\'s timing window minus the median of the same slot on the other four boards (sensor counts), {0}\n'
         'Blue = shorter than its siblings (predicted louder).  Orange = longer (predicted quieter).  '
         'Black ring = 12 or more away.  Small text = HKL (q, r).'.format(source),
         'window − sibling median (counts)')
    if n_runs >= 2:
        spreads = sorted(x['spread_leveled'] for x in keys)
        draw('spread.png', lambda x: x['spread_leveled'], spread_map,
             Normalize(vmin=0, vmax=max(10, percentile(spreads, 0.97)), clip=True),
             lambda v: '{0:.0f}'.format(v), lambda x: x['spread_leveled'] >= 10, '#d1442b',
             'Run-to-run spread of the learned MAX per key (largest − smallest over {0} runs, each run\'s overall level removed), in sensor counts\n'
             'Darker = less repeatable.  Red ring = 10 or more.  Small text = HKL (q, r).  Median key = {1:.1f}.'.format(
                 n_runs, st.median(spreads)),
             'spread (counts)')


def main():
    argv = sys.argv[1:]
    swap = '--swap-boards-34' in argv
    if swap:
        argv.remove('--swap-boards-34')
    opts = {'--top': '12', '--write': None, '--maps': None, '--level': None}
    for name in list(opts):
        if name in argv:
            i = argv.index(name)
            if i + 1 >= len(argv):
                sys.exit('{0} needs a value'.format(name))
            opts[name] = argv[i + 1]
            del argv[i:i + 2]
    if not argv or any(a.startswith('--') for a in argv):
        sys.exit('Usage: keydata-compare.py [--swap-boards-34] [--top N] [--level L] [--write DIR] [--maps DIR] <run-dir> [<run-dir> ...]')

    base_keys, standard_map, swapped_map = load_base_keys()
    runs = [load_run(d) for d in argv]
    names = [os.path.basename(os.path.normpath(d)) for d in argv]
    target_level = parse_level(opts['--level'], runs) if opts['--level'] else None
    keys = build_keys(runs, base_keys, swapped_map if swap else standard_map, target_level)
    report(names, runs, keys, int(opts['--top']), target_level)
    if opts['--write']:
        write_median(opts['--write'], argv[-1], runs, keys, target_level)
    if opts['--maps']:
        overheads = sorted(set(runs[-1][b]['overhead'] for b in BOARDS))
        draw_maps(opts['--maps'], keys, len(runs), '/'.join(map(str, overheads)), target_level)


if __name__ == '__main__':
    main()
