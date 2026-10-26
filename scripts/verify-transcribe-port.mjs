/**
 * Check the Node cue logic against the Python prototype's own output.
 *
 * server/services/transcribe.js is a port of test-sarvam-models/generate_srt.py,
 * and the cue rules in it were tuned and signed off on real episode output. This
 * rebuilds the SRT from the prototype's SAVED API responses (.raw.json) and
 * diffs it against the .srt the Python script produced from the same data — so
 * any drift in segmentation, splitting or timing shows up immediately, with no
 * API calls and nothing billable.
 *
 * Expect only ±1 ms differences on a few cues: Python's round() is
 * round-half-to-even, JavaScript's Math.round is half-up.
 *
 * Usage:  node scripts/verify-transcribe-port.mjs
 *
 * Needs the test-sarvam-models/ folder, which is a local research folder and is
 * not part of the repo. The script exits quietly if it isn't there.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { segmentToCues, buildSrt } from '../server/services/transcribe.js';

const dir = new URL('../test-sarvam-models/', import.meta.url);
const RUNS = ['generated_v4_hindi_locked', 'generated_v3_hindi_locked', 'generated_v2_phrase_level'];

if (!existsSync(fileURLToPath(dir))) {
  console.log('test-sarvam-models/ not present — nothing to compare against. Skipping.');
  process.exit(0);
}

let worstDeltaMs = 0;
let compared = 0;

for (const run of RUNS) {
  const rawPath = new URL(`${run}.raw.json`, dir);
  const srtPath = new URL(`${run}.srt`, dir);
  if (!existsSync(fileURLToPath(rawPath)) || !existsSync(fileURLToPath(srtPath))) {
    console.log(`${run}: fixtures missing, skipped`);
    continue;
  }
  compared++;

  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const cues = [];
  for (const entry of raw) {
    if (!entry.response) continue;
    cues.push(...segmentToCues(entry.start, entry.end, entry.response.transcript || ''));
  }

  const mine = buildSrt(cues).split(/\r?\n/);
  const python = readFileSync(srtPath, 'utf8').split(/\r?\n/);

  if (mine.length !== python.length) {
    console.error(`${run}: STRUCTURAL DIFFERENCE — ${mine.length} lines vs ${python.length}`);
    process.exitCode = 1;
    continue;
  }

  // Compare line by line, allowing only millisecond rounding on timing lines.
  const textDiffs = [];
  let maxDelta = 0;
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] === python[i]) continue;
    const a = mine[i].match(/^(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)$/);
    const b = python[i].match(/^(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)$/);
    if (a && b) {
      const ms = (m, o) => ((+m[o + 1] * 3600 + +m[o + 2] * 60 + +m[o + 3]) * 1000) + +m[o + 4];
      maxDelta = Math.max(maxDelta, Math.abs(ms(a, 0) - ms(b, 0)), Math.abs(ms(a, 4) - ms(b, 4)));
      continue;
    }
    textDiffs.push({ line: i + 1, node: mine[i], python: python[i] });
  }

  worstDeltaMs = Math.max(worstDeltaMs, maxDelta);

  if (textDiffs.length) {
    console.error(`${run}: ${cues.length} cues — ${textDiffs.length} TEXT DIFFERENCE(S)`);
    for (const d of textDiffs.slice(0, 5)) {
      console.error(`   line ${d.line}\n     node  : ${JSON.stringify(d.node)}\n     python: ${JSON.stringify(d.python)}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`${run}: ${cues.length} cues — text identical, timing within ${maxDelta} ms`);
  }
}

if (compared === 0) {
  console.log('No fixtures found to compare.');
} else if (worstDeltaMs > 1) {
  console.error(`\nTiming drifted by up to ${worstDeltaMs} ms — more than rounding. Check the segmentation constants.`);
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log(`\nPort matches the approved prototype output (max ${worstDeltaMs} ms rounding difference).`);
}
