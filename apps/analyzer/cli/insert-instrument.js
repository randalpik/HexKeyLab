#!/usr/bin/env node
/**
 * insert-instrument.js — splice a generated block into src/audio/samples.ts.
 *
 * Usage:
 *   node analyzer/insert-instrument.js <config.json>
 *
 * Reads:
 *   analyzer/out/<key>-block.txt   (produced by generate-samples.js)
 *
 * Behavior:
 *   - If `<key>:{` already appears in samples.ts, replaces the existing block
 *     (matched by `^    <key>:{` through the closing `^    },` line).
 *   - Else, appends the new block before the closing `};` of the INSTRUMENTS
 *     map (so it lands among the other instruments).
 *
 * Idempotent and safe: refuses to write if the block file is empty or doesn't
 * start with the expected `    <key>:{` line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '../..');
/* The INSTRUMENTS map was split out of samples.ts into samples-data.ts when
   the audio engine was modularized — we splice into that file now. */
const SAMPLES_TS = path.join(REPO, 'apps', 'hkl', 'src', 'audio', 'samples-data.ts');
const OUT_DIR = path.join(__dirname, '..', 'out');

function loadConfig() {
  const cfgPath = process.argv[2];
  if (!cfgPath) { console.error('Usage: node insert-instrument.js <config.json>'); process.exit(1); }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function findBlockBounds(lines, key) {
  const startRe = new RegExp(`^    ${key}:\\{`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  // Walk forward to the matching `    },` closing the instrument block. This
  // is sample-engine source, hand-written, so the closing convention is
  // consistent: the first line after `start` matching exactly `    },` ends
  // the block. If we ever switch to nested objects deep enough to confuse
  // this, fall back to brace counting.
  for (let i = start + 1; i < lines.length; i++) {
    // The last instrument in INSTRUMENTS uses `    }` (no comma); all others
    // use `    },`. Match both.
    if (lines[i] === '    },' || lines[i] === '    }') return { start, end: i };
  }
  return null;
}

function findInsertionPoint(lines) {
  // Insert just before the closing brace of `export const INSTRUMENTS: Record<...>`.
  // The current file has it at column 0 (`};`); accept indented variants too in
  // case the formatter ever wraps the map.
  let inMap = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inMap && /INSTRUMENTS:\s*Record/.test(lines[i])) inMap = true;
    if (inMap && (lines[i] === '};' || lines[i] === '  };')) return i;
  }
  return -1;
}

function main() {
  const cfg = loadConfig();
  const blockPath = path.join(OUT_DIR, `${cfg.instrumentKey}-block.txt`);
  if (!fs.existsSync(blockPath)) {
    console.error(`block file not found: ${blockPath}`);
    console.error(`run: node analyzer/generate-samples.js ${process.argv[2]}`);
    process.exit(1);
  }
  const block = fs.readFileSync(blockPath, 'utf8').replace(/\n+$/,'');
  if (!block) { console.error('block file is empty'); process.exit(1); }
  const expectedHeader = `    ${cfg.instrumentKey}:{`;
  if (!block.startsWith(expectedHeader)) {
    console.error(`block does not start with "${expectedHeader}"`);
    process.exit(1);
  }
  const blockLines = block.split('\n');

  const orig = fs.readFileSync(SAMPLES_TS, 'utf8');
  const lines = orig.split('\n');
  const bounds = findBlockBounds(lines, cfg.instrumentKey);

  let updated;
  if (bounds) {
    console.error(`replacing existing ${cfg.instrumentKey} block (lines ${bounds.start+1}–${bounds.end+1})`);
    updated = [...lines.slice(0, bounds.start), ...blockLines, ...lines.slice(bounds.end+1)];
  } else {
    const insertAt = findInsertionPoint(lines);
    if (insertAt < 0) { console.error('could not locate INSTRUMENTS map closing brace'); process.exit(1); }
    console.error(`appending new ${cfg.instrumentKey} block (before line ${insertAt+1})`);
    updated = [...lines.slice(0, insertAt), ...blockLines, ...lines.slice(insertAt)];
  }

  fs.writeFileSync(SAMPLES_TS, updated.join('\n'));
  console.error(`wrote ${SAMPLES_TS}`);
}

main();
