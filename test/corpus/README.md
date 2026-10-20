# MuseScore MusicXML corpus — import + partition study

Arbitrary real music for the partition work (docs/composer-partition-consistency-spec.md)
and for import gaps, instead of the one document Composer was built on.
Started 2026-10-20; next step: batch through the whole archive.

## The archive

`~/Downloads/mxl.tar.gz` (1.9 GB, Max's download). **254,035 `.mxl` files**, nothing
else, laid out `mxl/<0–17>/<bucket>/<name>.mxl`:

- **Hash-sharded, no categories.** 1,000 buckets of ~254 files (113–304); the
  names are 50-character IPFS-style hashes (`Qm…`), and a file's bucket is fixed
  by characters 3–4 of its name (one-to-one). Placement says nothing about the
  music, so a uniform random sample is representative.
- **All MuseScore exports** (450/450 sampled), `score-partwise`, UTF-8. Owner
  `pnlong` and the layout suggest the PDMX dataset — an inference, unconfirmed.
- **Skewed tiny**: `.mxl` size median 3.3 KB, p90 14 KB, p99 78 KB, max 2.35 MB
  (compressed). The random sample's median score is 18 measures, 1 part, 1 staff.

**Untrusted input.** Never extract by archive path. `sample_extract.py` streams the
tarball once, reads only the chosen members in memory, opens each zip from bytes,
takes the root file named by `META-INF/container.xml` (first `.xml`/`.musicxml`
otherwise), caps it at 50 MB uncompressed, and writes `<M>/<set>/<hash>.musicxml`.
Run the Python with `-I`, from this directory, never from inside the work dir.
`.mxl` stays out of the APP's scope (Max) — only this harness unzips.

## Pipeline

`M` is a scratch work dir (outputs are regenerable; the 2026-10-20 run's lived in
a session scratchpad and is gone — the seed reproduces the sample).

```bash
tar -tzvf ~/Downloads/mxl.tar.gz > $M/listing.txt                      # ~6 s
mkdir -p $M/random $M/large
python3 -I test/corpus/sample_extract.py $M ~/Downloads/mxl.tar.gz 300 100 50 20261020   # ~12 s
python3 -I test/corpus/survey.py $M                             # content survey → survey.json
(ls $M/random/*.musicxml; ls $M/large/*.musicxml) > $M/all.txt
node test/corpus/batch-import.mjs $M/all.txt $M/out --reload-every 20 --timeout 180   # needs pnpm dev
node test/corpus/corpus-report.mjs $M/out --survey $M/survey.json --gamma 0.03 --json $M/report.json
node test/balance/curve-batch.mjs $M/out/<name>.json --gammas 0,0.03     # one document's curve
```

`batch-import.mjs` imports each file's BYTES through the app's own decoder
(`__composerImportMusicXmlBytes`), waits out the render, runs
`partition-inputs.js`, and writes one record per file (import outcome, status line,
console errors/warnings/exceptions, timings, dump). It is resumable (existing
records are skipped) and reloads the page every N files and after any timeout.
Batch dumps were checked equal to isolated `run-probe.mjs` dumps (starts, pages,
naturals, leading blocks).

**Throughput** (one Chromium): random-set mean 0.57 s/file (median 0.17, p90 0.76,
max 20); large set mean 6.6 s (median 2.4, p90 18, max 78). The whole archive at
the random mean ≈ **40 h**. These are correctness runs, not timing, so disjoint
lists in parallel `batch-import.mjs` processes (each picks its own debug port)
are fine. Keep the records, not the extracted XML, if disk matters.

## Results so far (450 files: 300 random + 150 large by size)

**Content** (random / large): measures median 18 / 88 (max 504 / 737); parts 1 / 5
(max 18 / 50); >1 voice 24% / 70%; tuplets 17% / 49%; lyrics 14% / 38%; grace
notes 15% / 34%; meter changes 12% / 36%; unpitched notes 2% / 21%; invisible
notes 2% / 11%.

**Import**: 450/450, no failures, timeouts, console errors or exceptions. Fixed in
this round (each with a fixture, decisions.md 2026-10-20): UTF-16 / declared
encodings; parts with unpitched notes dropped whole; invisible playback notes
dropped; hidden double sharp written `accid.ges="x"` (now `ss`); slur pairing in
document order (chained slurs on one note; end-first cross-voice slurs).
Re-importing the 23 slur-warned files: identical-end slur warnings 270 → 0,
backwards 209 → 0. Remaining Verovio warnings are expected or out of scope:
"could not be matched" for ties/slurs into unloaded pages (page view loads only
visible pages), "Justification is highly compressed" (today's partition
compresses), and — out of scope (Max) — "Expected @tie median or terminal" and
ottavas "not encoded in the measure of its start".

**Partition (simulated F at γ 0.03; final sections under 3 lines excluded):**

| | random (275 sections, median 4 lines) | large (189, median 17, max 220) |
|---|---|---|
| greedy last line < 0.65 | 165 (60%) | 122 (65%) |
| last ≥ 0.65 — pick / full balance / today | 261 / 263 / 274 | 161 / 166 / 187 |
| sections moving 5+ boundaries — pick / full | 8 / 47 | 14 / 110 |
| pick = full, where full changes anything | 122 / 209 | 39 / 163 |
| last-line loss vs full (p90) | 0.153 | 0.209 |
| sparsest-line loss vs full (p90) | 0.035 | 0.089 |
| today compresses a line > 1.00 | 33 | 67 |

Max's rulings on these: γ = 0.03 with a flat cost per change stands; a section just
over one line long becomes two lines, no compression; long uniform sections may
keep a sparse-ish last line when the next improvement needs many moves (locks are
the remedy).

## Next (Max, 2026-10-20)

Batch through the archive: shard `listing.txt` into lists (by bucket), run
`batch-import.mjs` per list (resumable), aggregate with `corpus-report.mjs`
(add a `--set` from the shard if useful), and record new import gaps as they
appear — note them, then ask Max what is in scope. Once the app implements F
(spec Phases 1–4), re-run the sample and require the app's partition to equal the
simulation's pick.

## Files

- `sample_extract.py` — seeded sample + safe extraction (above).
- `survey.py` — offline content survey of the extracted XML.
- `slurscan.py`, `orphanscan.py` — the slur-pattern evidence behind `pairSlurs`.
- `batch-import.mjs` — in-browser batch import + dump (default probe `../composer-inspect/sonata-probes/partition-inputs.js`).
- `corpus-report.mjs` — the aggregate report (import outcomes + the change-weighted curve).
- `../balance/partition-f.mjs`, `../balance/curve-batch.mjs` — the simulated partition function F and its per-document curves.
