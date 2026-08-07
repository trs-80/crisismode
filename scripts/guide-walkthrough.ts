// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CLI entry point for the remediation-guide human walk-through.
 *
 *   pnpm run guides:walkthrough          # generate the checklist
 *   pnpm run guides:apply <checklist>    # ingest verdicts, stamp verifiedOn
 *
 * All logic lives in src/framework/guidance/walkthrough.ts so it is
 * typechecked and unit-tested with the rest of the guidance module.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMEDIATION_GUIDES } from '../src/framework/guidance/registry.js';
import {
  generateWalkthrough,
  parseVerdicts,
  applyVerdicts,
  stampChecklistFile,
  walkthroughFilename,
  isValidIsoDate,
} from '../src/framework/guidance/walkthrough.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES_DIR = join(REPO_ROOT, 'src', 'framework', 'guidance', 'guides');
const GUIDES_DIR_LABEL = 'src/framework/guidance/guides';
const OUTPUT_DIR = join(REPO_ROOT, 'docs', 'guide-verification');

/** Local calendar date (not UTC) — an evening-Pacific run should not date itself tomorrow. */
function todayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseArgs(argv: readonly string[]): { command: string | undefined; positional: string[]; force: boolean; date: string | undefined; dateProvided: boolean } {
  const positional: string[] = [];
  let force = false;
  let date: string | undefined;
  let dateProvided = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      // pnpm forwards the literal `--` from `pnpm run guides:walkthrough -- --force`;
      // treating it as a positional would write a checklist to a file named '--'.
      continue;
    }
    if (a === '--force') {
      force = true;
    } else if (a === '--date') {
      dateProvided = true;
      date = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], positional, force, date, dateProvided };
}

const { command, positional, force, date: dateFlag, dateProvided } = parseArgs(process.argv.slice(2));
const today = todayIso();

if (command === 'generate') {
  const outPath = positional[1] ?? join(OUTPUT_DIR, walkthroughFilename(today));
  if (existsSync(outPath) && !force) {
    console.error(`Refusing to overwrite existing checklist at ${outPath} — it may hold verdicts you haven't applied yet.`);
    console.error(`Run 'pnpm run guides:apply ${outPath}' first, or pass --force to regenerate anyway.`);
    process.exit(1);
  }
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, generateWalkthrough(REMEDIATION_GUIDES, today, GUIDES_DIR));
  console.log(`Walk-through checklist written to ${outPath}`);
  console.log(
    `${REMEDIATION_GUIDES.length} guides across ${new Set(REMEDIATION_GUIDES.map((g) => g.platform)).size} platforms.`,
  );
  console.log('Fill in the Verdict lines, then run: pnpm run guides:apply ' + outPath);
} else if (command === 'apply') {
  const file = positional[1];
  if (!file) {
    console.error('Usage: pnpm run guides:apply <checklist-file> [--date YYYY-MM-DD]');
    process.exit(1);
  }

  let date = today;
  if (dateProvided) {
    if (dateFlag === undefined || !isValidIsoDate(dateFlag)) {
      console.error(`Invalid --date "${dateFlag ?? '(missing value)'}" — expected a real YYYY-MM-DD calendar date.`);
      console.error('Usage: pnpm run guides:apply <checklist-file> [--date YYYY-MM-DD]');
      process.exit(1);
    }
    date = dateFlag;
  }

  const raw = readFileSync(file!, 'utf8');
  const { verdicts, warnings } = parseVerdicts(raw);
  for (const w of warnings) console.log(w);

  const ids = new Set(REMEDIATION_GUIDES.map((g) => g.id));
  const result = applyVerdicts(verdicts, date, GUIDES_DIR, ids);

  if (result.stamped.length > 0) {
    const updated = stampChecklistFile(raw, result.stamped, date);
    writeFileSync(file!, updated);
  }

  console.log(
    `Stamped verifiedOn: '${date}' on ${result.stamped.length} guide(s): ${result.stamped.join(', ') || '(none)'}`,
  );
  if (result.alreadyStamped.length > 0) {
    console.log('');
    console.log(
      `Already verified (${result.alreadyStamped.length}): ` +
        result.alreadyStamped.map((s) => `${s.guideId} (${s.date})`).join(', '),
    );
  }
  if (result.differs.length > 0) {
    console.log('');
    console.log('DIFFERS — these guides need their text fixed before stamping:');
    for (const d of result.differs) {
      const location = d.file ? ` [${GUIDES_DIR_LABEL}/${d.file}]` : '';
      console.log(`  - ${d.guideId}${location}: ${d.notes ?? '(no notes recorded — add what you saw)'}`);
    }
  }
  if (result.blocked.length > 0) {
    console.log('');
    console.log('Blocked — needs someone with access:');
    for (const b of result.blocked) {
      console.log(`  - ${b.guideId}: ${b.notes ?? '(no reason recorded)'}`);
      if (!b.notes) {
        console.log('    Add a **Notes:** line with a one-line reason so this shows up as a real coverage gap, not silence.');
      }
    }
  }
  if (result.pending.length > 0) {
    console.log('');
    console.log(`Still pending (${result.pending.length}): ${result.pending.join(', ')}`);
    console.log('Re-run apply on the same file whenever you verify more.');
  }
  if (result.unknown.length > 0) {
    console.log('');
    console.log(`Unknown guide ids in checklist (stale file? regenerate): ${result.unknown.join(', ')}`);
  }

  const verified = result.stamped.length + result.alreadyStamped.length;
  console.log('');
  console.log(`${verified} of ${REMEDIATION_GUIDES.length} guides now verified.`);

  if (result.stamped.length > 0) {
    console.log('');
    console.log('Run `pnpm test` to confirm the freshness check, then commit the stamped guide files and this checklist.');
  }
} else {
  console.error('Usage: guide-walkthrough.ts <generate [out-path] [--force] | apply <checklist-file> [--date YYYY-MM-DD]>');
  process.exit(1);
}
