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
import { CliUsageError, ExitCode } from '../exit-codes.js';

export interface BundleOptions {
  subcommand: string;
  args: string[];
  output?: string | undefined;
}

export async function runBundle(options: BundleOptions): Promise<ExitCode> {
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
      return ExitCode.USAGE;
  }
}

/**
 * Report a failed bundle run. A missing/unreadable argument is a usage
 * error (2, matching `down`); a bundle that loaded but could not be
 * processed is a real failure of the requested work (1).
 */
function reportFailure(verb: string, err: unknown): ExitCode {
  printError(`bundle ${verb} failed: ${err instanceof Error ? err.message : String(err)}`);
  return err instanceof CliUsageError ? ExitCode.USAGE : ExitCode.UNHEALTHY;
}

async function loadBundle(path: string | undefined): Promise<unknown> {
  if (!path) {
    throw new CliUsageError(
      'Usage: crisismode bundle ingest|respond|execute <path|-> [--output <file>]',
    );
  }
  const text = path === '-' ? await readStdin() : await readFile(path, 'utf-8');
  return JSON.parse(text);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliUsageError(
      'No data on stdin. Pipe a bundle JSON in, or pass a file path instead of "-".',
    );
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

async function runIngest(opts: BundleOptions): Promise<ExitCode> {
  try {
    const bundle = await loadBundle(opts.args[0]);
    const result = await ingestEvidenceBundle(bundle as never);
    await emit(result, opts.output);
    return ExitCode.OK;
  } catch (err) {
    return reportFailure('ingest', err);
  }
}

async function runRespond(opts: BundleOptions): Promise<ExitCode> {
  try {
    const bundle = await loadBundle(opts.args[0]);
    const result = await respondToEvidenceBundle(bundle as never);
    await emit(result.response, opts.output);
    return ExitCode.OK;
  } catch (err) {
    return reportFailure('respond', err);
  }
}

async function runExecute(opts: BundleOptions): Promise<ExitCode> {
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
    return ExitCode.OK;
  } catch (err) {
    return reportFailure('execute', err);
  }
}
