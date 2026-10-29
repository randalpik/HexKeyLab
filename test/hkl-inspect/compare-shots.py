#!/usr/bin/env python3
"""Compare two layout-shots.mjs runs pixel for pixel.

    python3 test/hkl-inspect/compare-shots.py DIR_A DIR_B [HEATMAP_DIR]

Prints, per shot, the number of pixels whose RGBA differs at all (and the size
if the two differ). With HEATMAP_DIR, every differing pair gets a full-page
heatmap from test/composer-test/heatmap.py (never cropped). Exits 1 if any
shot differs or is missing from either side.
"""
import json, subprocess, sys
from pathlib import Path
from PIL import Image
import numpy as np

a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
heat_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else None
heatmap = Path(__file__).resolve().parent.parent / 'composer-test' / 'heatmap.py'

names = [s['name'] for s in json.loads((a_dir / 'manifest.json').read_text())]
bad = 0
for name in names:
    pa, pb = a_dir / name, b_dir / name
    if not pb.exists():
        print(f'MISSING  {name}'); bad += 1; continue
    a = np.asarray(Image.open(pa).convert('RGBA'))
    b = np.asarray(Image.open(pb).convert('RGBA'))
    if a.shape != b.shape:
        print(f'SIZE     {name}  {a.shape[1]}x{a.shape[0]} vs {b.shape[1]}x{b.shape[0]}'); bad += 1
        diff = None
    else:
        diff = int(np.any(a != b, axis=2).sum())
        print(f'{"SAME" if diff == 0 else "DIFF"}     {name}  {diff} px')
        if diff: bad += 1
    if heat_dir and (diff is None or diff):
        heat_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run([sys.executable, str(heatmap), str(pa), str(pb), str(heat_dir / name),
                        '--label', f'{a_dir.name} vs {b_dir.name}: {name}'], check=False)
print(f'\n{len(names) - bad}/{len(names)} identical')
sys.exit(1 if bad else 0)
