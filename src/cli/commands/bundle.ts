// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CLI command: crisismode bundle <subcommand>
 *
 * Subcommands:
 *   ingest  <path>   — validate an evidence bundle and emit a DiagnosisResult
 *   respond <path>   — emit an AdapterResponse (incident-generator v1) suitable
 *                      for piping into the sre-incident-agent-skills judge
 *   execute <path>   — respond + translate to a CrisisMode RecoveryPlan
 *                      (dry-run by default; --execute is NOT yet wired)
 *
 * Always writes machine-readable JSON to stdout (or --output file).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { ingestEvidenceBundle } from '../../framework/evidence-bundle-ingest.js';
import { respondToEvidenceBundle } from '../../framework/evidence-bundle-respond.js';
import { adapterResponseToPlan } from '../../framework/bundle-to-plan.js';
import { printError } from '../output.js';

export interface BundleOptions {
  subcommand: string;
  args: string[];
  output?: string | undefined;
}

export async function runBundle(options: BundleOptions): Promise<void> {
  switch (options.subcommand) {
    case 'ingest':
      return runIngest(options);
    case 'respond':
      return runRespond(options);
    case 'execute':
      return runExecute(options);
    default:
      printError(`Unknown subcommand: ${options.subcommand}`);
      printError(
        'Usage: crisismode bundle ingest|respond|execute <path> [--output <file>]',
      );
      process.exit(1);
  }
}

async function loadBundle(path: string | undefined): Promise<unknown> {
  if (!path) {
    printError(
      'Usage: crisismode bundle ingest|respond|execute <path|-> [--output <file>]',
    );
    process.exit(1);
  }
  const text = path === '-' ? await readStdin() : await readFile(path, 'utf-8');
  return JSON.parse(text);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    printError(
      'No data on stdin. Pipe a bundle JSON in, or pass a file path instead of "-".',
    );
    process.exit(1);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function emit(payload: unknown, output: string | undefined): Promise<void> {
  const json = JSON.stringify(payload, null, 2);
  if (output) {
    await writeFile(output, json + '\n', 'utf-8');
  } else {
    process.stdout.write(json + '\n');
  }
}

async function runIngest(opts: BundleOptions): Promise<void> {
  try {
    const bundle = await loadBundle(opts.args[0]);
    const result = await ingestEvidenceBundle(bundle as never);
    await emit(result, opts.output);
  } catch (err) {
    printError(`bundle ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runRespond(opts: BundleOptions): Promise<void> {
  try {
    const bundle = await loadBundle(opts.args[0]);
    const result = await respondToEvidenceBundle(bundle as never);
    await emit(result.response, opts.output);
  } catch (err) {
    printError(`bundle respond failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runExecute(opts: BundleOptions): Promise<void> {
  try {
    const bundle = await loadBundle(opts.args[0]);
    const respondResult = await respondToEvidenceBundle(bundle as never);
    const planResult = adapterResponseToPlan(bundle as never, respondResult.response);
    await emit(
      {
        plan: planResult.plan,
        rejected: planResult.rejected,
        warnings: planResult.warnings,
        response_state: respondResult.response.state,
      },
      opts.output,
    );
  } catch (err) {
    printError(`bundle execute failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
