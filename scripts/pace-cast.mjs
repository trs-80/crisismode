// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Re-time an asciicast v3 recording so it is readable as a web asset.
 *
 * WHY: `crisismode demo` sleeps between its 10 phases but emits each phase's
 * output in a single instantaneous write. Phase 9 (execution) dumps 82 lines at
 * once, so in a 24-30 row window everything except the last screenful scrolls
 * past in a single frame and can never be read.
 *
 * WHAT THIS DOES: splits multi-line output events into one event per line and
 * assigns each a delay, so output streams at reading speed.
 *
 * WHAT THIS DOES NOT DO: it never alters a single byte of output content. Step
 * durations the demo prints (e.g. "SUCCESS (1ms)") remain the real measured
 * values — only the delay between lines arriving is synthesized.
 *
 * IDLE GAPS ARE CAPPED at MAX_IDLE_GAP (4s). Original gaps are otherwise a
 * floor and never shortened, so the demo's own deliberate pauses and the
 * operator's typing cadence survive untouched — but the live AI diagnosis call
 * in Phase 5 really does take 28-40s, and a frozen frame that long reads as a
 * hung page rather than a pause. The cast is already fully re-timed for
 * readability, so it was never a real-time artifact; clamping one dead gap is
 * consistent with that. The true latency is reported by whoever records, not
 * implied by the playback.
 *
 * Usage: node scripts/pace-cast.mjs <in.cast> <out.cast>
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// ── Pacing model (seconds) ───────────────────────────────────────────────
const DELAY = {
  /** Ordinary content line. */
  line: 0.1,
  /** Blank line — a beat, not a full line. */
  blank: 0.05,
  /** Box-drawing rule; part of a heading, should land with it. */
  rule: 0.04,
  /** Before a `Phase N:` heading — the main structural beat. */
  phase: 0.85,
  /** Before an execution step heading. */
  step: 0.45,
  /** Before a finding/result marker line. */
  marker: 0.16,
};

/**
 * Ceiling on any single gap between events. Sized above the longest deliberate
 * pause in the expect driver (2.5s to read the approval panel, 2.5s to hold the
 * final frame) so those survive untouched, and below the live AI call's real
 * 28-40s so that one becomes a readable beat instead of a stall.
 */
const MAX_IDLE_GAP = 4.0;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text) {
  return text.replace(ANSI, '');
}

/**
 * An output event is left at its original timing if it looks like interactive
 * echo (the operator typing at the approval gate) rather than program output:
 * no newline and only a few characters.
 */
function isTypingEcho(data) {
  return !data.includes('\n') && stripAnsi(data).length <= 3;
}

function delayForLine(line) {
  // Strip ANSI so the classifiers match on visible text.
  const plain = stripAnsi(line);
  const trimmed = plain.trim();

  if (trimmed === '') return DELAY.blank;
  if (/^[─═│┌┐└┘├┤┬┴┼]+$/.test(trimmed)) return DELAY.rule;
  if (/^Phase \d+:/.test(trimmed)) return DELAY.phase;
  if (/^Step step-/.test(trimmed)) return DELAY.step;
  if (/^[✓✗●◆◇◈↻⚠→•]/.test(trimmed) || /^\[(CRITICAL|WARNING|INFO)\]/.test(trimmed)) {
    return DELAY.marker;
  }
  return DELAY.line;
}

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/pace-cast.mjs <in.cast> <out.cast>');
  process.exit(1);
}

const raw = readFileSync(inPath, 'utf8').trim().split('\n');
const header = JSON.parse(raw[0]);
if (header.version !== 3) {
  console.error(`pace-cast: expected asciicast v3, got version ${header.version}`);
  process.exit(1);
}

// The capture runs through a temp expect driver, so the recorded `command` is a
// throwaway /var/folders path. Replace it with the command it actually drove.
header.command = 'crisismode demo';

const out = [JSON.stringify(header)];
let originalWall = 0;
let pacedWall = 0;
let splitCount = 0;
let cappedCount = 0;
let longestOriginalGap = 0;

for (const rawLine of raw.slice(1)) {
  if (!rawLine.trim()) continue;
  const event = JSON.parse(rawLine);
  const [interval, code, data] = event;
  originalWall += interval;
  if (interval > longestOriginalGap) longestOriginalGap = interval;
  if (interval > MAX_IDLE_GAP) cappedCount += 1;

  if (code !== 'o' || isTypingEcho(data) || !data.includes('\n')) {
    const gap = Math.min(interval, MAX_IDLE_GAP);
    out.push(JSON.stringify([Number(gap.toFixed(3)), code, data]));
    pacedWall += gap;
    continue;
  }

  // Split on newline, keeping the terminator attached to its line so the
  // reconstructed stream is byte-identical to the original.
  const chunks = data.split(/(?<=\n)/);
  splitCount += 1;

  let first = true;
  for (const chunk of chunks) {
    if (chunk === '') continue;
    // The original gap is a floor: never speed the recording up — except that
    // no single gap may exceed MAX_IDLE_GAP.
    const paced = delayForLine(chunk);
    const gap = first ? Math.min(Math.max(interval, paced), MAX_IDLE_GAP) : paced;
    out.push(JSON.stringify([Number(gap.toFixed(3)), 'o', chunk]));
    pacedWall += gap;
    first = false;
  }
}

// Write to a sibling temp file and rename into place only once the byte check
// below has passed. record-demo.sh passes a committed site asset as outPath, so
// writing there before verifying would overwrite the good cast with the rejected
// one — while printing "refusing to ship". The temp file is a sibling so the
// rename stays on one filesystem and is therefore atomic.
const tmpPath = join(dirname(outPath), `.${basename(outPath)}.pace-cast.${process.pid}.tmp`);

let tmpPending = false;
const removeTmp = () => {
  if (!tmpPending) return;
  tmpPending = false;
  try {
    unlinkSync(tmpPath);
  } catch {
    // Already gone: renamed into place, or removed by an earlier handler.
  }
};

// Covers every exit path Node can observe — normal return, process.exit(), and
// uncaught throws. Signals do not run 'exit' handlers by themselves, so they are
// wired to it explicitly. (SIGKILL is uncatchable and cannot be covered.)
process.on('exit', removeTmp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    removeTmp();
    process.exit(1);
  });
}

// Set before the write, not after: a write that throws part-way through still
// leaves a partial file to clean up.
tmpPending = true;
writeFileSync(tmpPath, out.join('\n') + '\n');

// Verify content is unchanged — pacing must be timing-only.
const bytesOf = (path) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e[1] === 'o')
    .map((e) => e[2])
    .join('');

if (bytesOf(inPath) !== bytesOf(tmpPath)) {
  console.error('pace-cast: FAILED — output bytes differ from input; refusing to ship');
  console.error(`pace-cast: ${outPath} left untouched`);
  // The 'exit' handler discards the rejected cast.
  process.exit(1);
}

renameSync(tmpPath, outPath);
tmpPending = false;

console.log(
  `pace-cast: ${originalWall.toFixed(1)}s -> ${pacedWall.toFixed(1)}s ` +
    `(${splitCount} bursts split, output bytes verified identical)`,
);
console.log(
  `pace-cast: longest original gap ${longestOriginalGap.toFixed(1)}s; ` +
    `${cappedCount} gap(s) capped at ${MAX_IDLE_GAP}s`,
);
