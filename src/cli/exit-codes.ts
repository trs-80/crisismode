// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The CLI's exit-code contract — one named enum, one source of truth.
 *
 * Before this existed there were 40 `process.exit` call sites across 8 files
 * and they disagreed: `crisismode down --bogusflag` exited 2 while
 * `crisismode agent` (a missing subcommand — the same class of error) exited
 * 1, and `scan`/`diagnose`/`recover`/`status`/`readiness` never set an exit
 * code at all, so a scan of a dead database exited 0.
 *
 * Commands *return* one of these; `run.ts` is the only place that turns a
 * returned code into `process.exitCode`.
 */
export const ExitCode = {
  /** Everything checked looks fine, or the command did what was asked. */
  OK: 0,
  /**
   * The command ran correctly and the answer is bad news: a target is
   * unhealthy or recovering, a service is down, a validation failed. This is
   * the code a `crisismode && deploy` chain or a CI gate keys on.
   */
  UNHEALTHY: 1,
  /**
   * The command itself was called wrong: unknown command, unknown flag, a
   * flag missing its value, a missing required subcommand, or a config file
   * that does not exist or does not parse. Adopted from `down`, the one
   * command that already got this right.
   */
  USAGE: 2,
  /**
   * An unexpected failure inside CrisisMode. Distinct from UNHEALTHY so a
   * script can tell "your infrastructure is broken" from "this tool is
   * broken". 70 is sysexits.h's EX_SOFTWARE.
   */
  INTERNAL: 70,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * "You called this wrong" raised from somewhere that cannot return a code —
 * a helper several call sites deep, or argument validation inside a command.
 * `run.ts`'s error boundary maps it to `ExitCode.USAGE`; anything else that
 * escapes is `ExitCode.INTERNAL`. This is what lets a nested helper stop
 * calling `process.exit()` without inventing a return-code channel through
 * every caller.
 */
export class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}
