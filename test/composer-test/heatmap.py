#!/usr/bin/env python3
"""Pixel-diff HEATMAP of two Composer renders — the standing way to surface a
visual disagreement in this project (test/composer-test/README.md, "Reviewing a
visual failure").

    python3 heatmap.py A.png B.png OUT.png [--label "what pair this is"]

Red marks every pixel where the two renders disagree: per-pixel MAX CHANNEL
DELTA, amplified 6x, laid over a dimmed copy of A so the music stays legible as
context. The banner carries `diff / >32 / max`.

Rules baked in, because each was learned the hard way:
  * NEVER crop, shift or align to make a point — the full page goes in, both
    images are padded to their union size if they differ, and a size mismatch
    is reported rather than fixed up.
  * The pair matters more than the picture. Baseline-vs-output only answers
    "did the rendering change", which is non-zero by construction after an
    intended change; the DEFECT question is self-consistency (a spliced page
    against a full re-engrave of the same document, same container, same
    scroll, same capture path). Pass --label and say which pair it is.
"""
import sys
from PIL import Image, ImageDraw
import numpy as np

args = [a for a in sys.argv[1:] if not a.startswith('--')]
label = None
if '--label' in sys.argv:
    label = sys.argv[sys.argv.index('--label') + 1]
if len(args) < 3:
    print(__doc__)
    sys.exit(2)
a_path, b_path, out_path = args[0], args[1], args[2]

A = Image.open(a_path).convert('RGB')
B = Image.open(b_path).convert('RGB')
note = ''
if A.size != B.size:
    note = f'  SIZE MISMATCH {A.size} vs {B.size} — padded, not aligned'
    W, H = max(A.width, B.width), max(A.height, B.height)
    pa = Image.new('RGB', (W, H), (255, 255, 255)); pa.paste(A, (0, 0)); A = pa
    pb = Image.new('RGB', (W, H), (255, 255, 255)); pb.paste(B, (0, 0)); B = pb

a = np.asarray(A).astype(np.int16)
b = np.asarray(B).astype(np.int16)
delta = np.abs(a - b).max(axis=2)              # per-pixel max channel delta

n_diff = int((delta > 0).sum())
n_sig = int((delta > 32).sum())
d_max = int(delta.max())

# Dimmed copy of A as context, then paint amplified red over it.
base = (np.asarray(A).astype(np.float32) * 0.25 + 191).astype(np.uint8)
amp = np.clip(delta.astype(np.float32) * 6.0, 0, 255)
out = base.astype(np.float32)
out[..., 0] = np.maximum(out[..., 0], amp)                       # red up
out[..., 1] = out[..., 1] * (1.0 - amp / 255.0 * 0.85)           # green/blue down
out[..., 2] = out[..., 2] * (1.0 - amp / 255.0 * 0.85)
img = Image.fromarray(out.astype(np.uint8))

BANNER = 34
canvas = Image.new('RGB', (img.width, img.height + BANNER), (24, 26, 32))
canvas.paste(img, (0, BANNER))
d = ImageDraw.Draw(canvas)
txt = f'diff {n_diff}  |  >32 {n_sig}  |  max {d_max}'
if label:
    txt = f'{label}    {txt}'
d.text((10, 11), txt + note, fill=(255, 220, 220))
canvas.save(out_path)
print(f'{out_path}  diff={n_diff} >32={n_sig} max={d_max}{note}')
