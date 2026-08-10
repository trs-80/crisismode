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
 * Filesystem errno codes that mean "the path you named is not a readable
 * file" — the user naming something that isn't there, not a processing
 * failure. ENOTDIR covers `a/file/that/is/not/a/dir/x.json`.
 */
const UNREADABLE_PATH_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

function isUnreadablePath(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code !== undefined && UNREADABLE_PATH_CODES.has(code);
}

/**
 * Report a failed bundle run.
 *
 * USAGE (2) when the argument itself was wrong: missing, or a path that is
 * not a readable file. That matches `playbook validate /nope.md` and the
 * documented matrix ("missing/unreadable path" -> 2); it previously returned
 * UNHEALTHY, which told a script the *bundle* was bad when the file was
 * simply not there.
 *
 * UNHEALTHY (1) stays for a bundle that loaded and then failed — malformed
 * JSON, schema violations, a diagnosis that could not complete. The call was
 * correct; the work failed.
 */
function reportFailure(verb: string, err: unknown): ExitCode {
  printError(`bundle ${verb} failed: ${err instanceof Error ? err.message : String(err)}`);
  return err instanceof CliUsageError || isUnreadablePath(err) ? ExitCode.USAGE : ExitCode.UNHEALTHY;
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
