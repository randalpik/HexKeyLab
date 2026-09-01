#!/bin/bash
# Exhaustive splice sweep: edit EVERY measure of the sonata and record the
# outcome. This is the periodic deep pass — cb-sweep.js (one mid-line measure
# per line) is the routine gate.
#
# Chunked because the probe runner's Runtime.evaluate deadline is 300 s and the
# full 446-measure walk needs ~4x that. Each chunk is written as it completes,
# so a kill costs at most one chunk and re-running skips whatever is already
# valid JSON. Re-run after a crash; delete the chunk files to force a fresh run.
#
#   test/composer-inspect/phasec/allmeasures.sh [outDir]
#   node test/composer-inspect/phasec/allmeasures-report.mjs [outDir]
#
# Requires pnpm dev, chromium, and the sonata (see README).
set -u
OUT="${1:-${TMPDIR:-/tmp}/hkl-allmeasures}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p "$OUT"
cd "$REPO"
CHUNK=70
TOTAL=$(( ${MEASURES:-446} ))
for (( FROM=0; FROM<TOTAL; FROM+=CHUNK )); do
  F="$OUT/allm-$FROM.json"
  if [ -s "$F" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$F" 2>/dev/null; then
    echo "chunk $FROM: already done"; continue
  fi
  echo "chunk $FROM: running"
  node test/composer-inspect/phasec/runner.mjs \
    test/composer-inspect/phasec/cb-allmeasures.js --arg "from=$FROM,limit=$CHUNK" > "$F" 2>&1
  if node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.__error)throw new Error(j.__error)' "$F" 2>/dev/null; then
    echo "chunk $FROM: ok"
  else
    echo "chunk $FROM: FAILED — $(head -c 140 "$F")"
  fi
done
echo "ALL CHUNKS DONE — report with: node test/composer-inspect/phasec/allmeasures-report.mjs $OUT"
