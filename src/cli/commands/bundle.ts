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
 * A JS runtime error type that can only mean a programming mistake inside
 * CrisisMode — never something the user's input can legitimately cause.
 * These are rethrown so `runCliSafely` reports INTERNAL (70).
 *
 * `SyntaxError` is deliberately NOT here: it is what `JSON.parse` throws for
 * a malformed bundle file, which is the user's input being wrong, not
 * CrisisMode being broken.
 */
function isProgrammingFault(err: unknown): boolean {
  return err instanceof TypeError
    || err instanceof RangeError
    || err instanceof ReferenceError
    || err instanceof EvalError;
}

/**
 * Report a failed bundle run, mapping the failure to the right code.
 *
 * - USAGE (2): the argument itself was wrong — missing, or a path that is not
 *   a readable file. Matches `playbook validate /nope.md` and the documented
 *   matrix; it used to return UNHEALTHY, telling a script the *bundle* was
 *   bad when the file simply was not there.
 * - INTERNAL (70), by rethrowing to the boundary: a programming fault inside
 *   CrisisMode. Every unknown error used to become UNHEALTHY, so a genuine
 *   tool bug exited 1 and blamed the bundle — which defeats the
 *   UNHEALTHY/INTERNAL distinction entirely.
 * - UNHEALTHY (1): everything else. The call was correct and the work failed
 *   on the input given — malformed JSON (`SyntaxError`), schema violations, a
 *   diagnosis that could not complete.
 *
 * The split is by JS error type because that is the only reliable signal
 * available here: the bundle framework raises untyped plain `Error`s for
 * validation (`framework/evidence-bundle-ingest.ts:45-84`), so "your bundle
 * is invalid" and "CrisisMode threw" are otherwise indistinguishable. A typed
 * `BundleValidationError` in `src/framework/**` would make this exact; that
 * is a follow-up, not something to guess at here — and guessing wrong in the
 * other direction (treating bad input as a tool bug) is the worse error,
 * since 70 is EX_SOFTWARE.
 */
function reportFailure(verb: string, err: unknown): ExitCode {
  if (isProgrammingFault(err)) throw err;
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
  const parsed: unknown = JSON.parse(text);
  // Valid JSON that is not an object (a bare string, number, null, or an
  // array) is bad user input, but it would reach ingestEvidenceBundle and
  // could surface as a TypeError on a property access — which
  // isProgrammingFault would then rethrow as INTERNAL (70), blaming
  // CrisisMode for the user's file. Reject the shape here so it stays
  // UNHEALTHY.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Evidence bundle must be a JSON object, got ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}`,
    );
  }
  return parsed;
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
