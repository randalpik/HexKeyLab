#!/bin/bash
# Run named fixtures against the UNFIXED composer source: stashes the working
# tree's apps/composer/src, runs each fixture in scenario mode under
# HKL_INDEX_CHECK, then restores. Every fixture written for a bug fix must FAIL
# here (lessons.md, "A boundary-condition fixture must be run against the
# UNFIXED build") — a fixture that passes on both builds tests nothing.
#
#   test/composer-test/run-unfixed.sh <fixtureName> [<fixtureName> ...]
#
# Requires pnpm dev. Do NOT run this (or run.mjs) with TMPDIR overridden to a
# deep path: Chromium honours TMPDIR for its own sockets and its debug endpoint
# then never comes up ("Chromium debug endpoint never came up", exit 2 — an
# INFRA failure, not a fixture result; measured 2026-09-04 under the session
# scratchpad). Leave TMPDIR alone; the default OUT is already under /tmp.
#
# Limitation: this stashes ALL of apps/composer/src, so "unfixed" means HEAD.
# A fixture for a fix that only matters on top of a feature in the same
# working tree (e.g. lazyMoveOut's re-place, which is only wrong under rule
# v2) passes here legitimately; prove such a fixture by reverting the one
# line instead.
#
# Waits a few seconds after the stash for Vite to settle
# (2026-09-01: the first scenario after a stash once failed to launch at all).
# Nothing else may use the dev server while this runs — the stash reloads every
# page it serves.
set -u
if [ $# -eq 0 ]; then echo "usage: $0 <fixtureName> ..."; exit 2; fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
OUT="${TMPDIR:-/tmp}/hkl-unfixed"
mkdir -p "$OUT"
git stash push -q -- apps/composer/src || { echo "stash failed (nothing to stash?)"; exit 1; }
echo "stashed apps/composer/src"
sleep 8
for n in "$@"; do
  HKL_INDEX_CHECK=1 timeout 300 node test/composer-test/run.mjs scenario "$n" > "$OUT/$n.log" 2>&1
  code=$?
  verdict=$(grep -o '✓\|✗' "$OUT/$n.log" | head -1)
  detail=$(grep -v '^\s*at ' "$OUT/$n.log" | grep '\[' | head -1 | cut -c1-200)
  echo "$n: exit $code ${verdict:-?} $detail"
done
git stash pop -q && echo "restored apps/composer/src" || echo "STASH POP FAILED — run: git stash pop"
