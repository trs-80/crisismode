// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Diagnosis eval runner.
 *
 * Drives the sre-incident-agent-skills 14-family compatibility benchmark
 * against the REAL crisismode CLI (`bundle respond -`) — not the fixture
 * shim — and writes a per-family report of what passes, what fails, and why.
 *
 * Usage:
 *   pnpm run eval:diagnosis                # AI-powered run (needs ANTHROPIC_API_KEY)
 *   pnpm run eval:diagnosis -- --no-ai     # abstention baseline (key stripped)
 *   pnpm run eval:diagnosis -- --adapter "custom command reading stdin"
 *
 * Env:
 *   SRE_SKILLS_REPO — path to the sre-incident-agent-skills checkout
 *                     (default: ../sre-incident-agent-skills)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBenchmarkResults, renderMarkdownReport } from '../src/eval/benchmark-report.js';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK_SET = 'harness/crisismode-compatibility-benchmark-set.yaml';

function parseArgs(argv: string[]) {
  const opts = { noAi: false, adapter: '', minScore: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-ai') opts.noAi = true;
    else if (argv[i] === '--adapter') opts.adapter = argv[++i] ?? '';
    else if (argv[i] === '--min-score') opts.minScore = Number(argv[++i] ?? 0);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const sreRepo = resolve(repoRoot, process.env.SRE_SKILLS_REPO ?? '../sre-incident-agent-skills');
  if (!existsSync(join(sreRepo, BENCHMARK_SET))) {
    console.error(`Benchmark set not found: ${join(sreRepo, BENCHMARK_SET)}`);
    console.error('Clone sre-incident-agent-skills as a sibling checkout or set SRE_SKILLS_REPO.');
    process.exit(1);
  }

  const bundlePath = join(repoRoot, 'dist/crisismode.bundle.cjs');
  let adapter = opts.adapter;
  if (!adapter) {
    if (!existsSync(bundlePath)) {
      console.error(`CLI bundle not found: ${bundlePath}`);
      console.error('Run `pnpm run build:bundle` first.');
      process.exit(1);
    }
    adapter = `node ${bundlePath} bundle respond -`;
  }

  const aiAvailable = !opts.noAi && !!process.env.ANTHROPIC_API_KEY;
  const mode = aiAvailable ? 'ai' : 'no-ai';
  const adapterLabel = `${adapter} [${mode}]`;

  const childEnv = { ...process.env };
  if (opts.noAi) delete childEnv.ANTHROPIC_API_KEY;

  console.error(`Running 14-family diagnosis benchmark (${mode}) against: ${adapter}`);
  console.error('This runs one real diagnosis per case — expect a few minutes with AI enabled.\n');

  // The benchmark runner exits nonzero when any case fails — that's a
  // valid result, not an execution error, so recover stdout from the error.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'python3',
      [
        '-m', 'incident_generator', 'benchmark-runner',
        '--benchmark-set', BENCHMARK_SET,
        '--adapter-command', adapter,
        '--json',
      ],
      { cwd: sreRepo, env: childEnv, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
    ));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    if (!e.stdout || !e.stdout.trimStart().startsWith('{')) {
      console.error(e.stderr ?? '');
      throw err;
    }
    stdout = e.stdout;
  }

  const payload = JSON.parse(stdout);
  const summary = summarizeBenchmarkResults(payload);

  let gitSha = 'unknown';
  try {
    gitSha = (await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  } catch {
    // not a git checkout — leave as unknown
  }

  const ranAt = new Date().toISOString();
  const md = renderMarkdownReport(summary, { adapterLabel, gitSha, ranAt });

  const reportsDir = join(repoRoot, 'eval/reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = ranAt.replace(/[:.]/g, '-');
  const base = join(reportsDir, `diagnosis-${stamp}-${mode}`);
  writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2));
  writeFileSync(`${base}.md`, md);

  console.log(md);
  console.error(`\nReport written to ${base}.md (raw JSON alongside)`);

  if (opts.minScore > 0 && summary.passedCount < opts.minScore) {
    console.error(`FAIL: score ${summary.score} below required minimum ${opts.minScore}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`diagnosis eval failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
