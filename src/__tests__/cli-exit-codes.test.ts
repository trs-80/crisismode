// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * C8a — the default command exited 0 with a dead database.
 *
 * A target returning `ECONNREFUSED 127.0.0.1:59999` produced
 * `status: unhealthy`, `score: 86`, and exit code 0: `scan.ts` (and
 * `diagnose`, `status`, `readiness`) contained zero `process.exit` /
 * `process.exitCode` writes, so every `crisismode && deploy` chain, CI gate
 * and cron alert was silently a no-op.
 *
 * These tests pin the single source of truth (`ExitCode`), the
 * status → exit-code mapping that lives beside the other status →
 * presentation mappings, and the routed exit codes for usage errors.
 */

import { describe, it, expect, vi } from 'vitest';
import { ExitCode } from '../cli/exit-codes.js';
import { severityExitCode, readinessExitCode } from '../cli/status-presentation.js';
import { exitCodeToStatus, exitStatusToHealth } from '../framework/check-plugin.js';
import { runCli } from '../cli/run.js';
import type { HealthStatus } from '../types/health.js';
import type { ReadinessReport } from '../readiness/types.js';

describe('ExitCode', () => {
  it('is the single named source of truth for the CLI contract', () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.UNHEALTHY).toBe(1);
    expect(ExitCode.USAGE).toBe(2);
    expect(ExitCode.INDETERMINATE).toBe(3);
    expect(ExitCode.INTERNAL).toBe(70);
  });

  /**
   * 3 is not a novel number: `framework/check-plugin.ts`'s EXIT_CODE_MAP
   * already ships 3 = unknown to plugin authors. Only that row is mirrored —
   * the plugin contract's 1 and 2 mean warning/critical, which answer a
   * different question than the CLI's UNHEALTHY/USAGE.
   */
  it('borrows 3 = unknown from the check-plugin contract the project already ships', () => {
    expect(exitCodeToStatus(3)).toBe('unknown');
    expect(exitStatusToHealth(exitCodeToStatus(3))).toBe('unknown');
    expect(ExitCode.INDETERMINATE).toBe(3);
  });
});

describe('severityExitCode', () => {
  it.each([
    [['healthy'], ExitCode.OK],
    [['healthy', 'healthy'], ExitCode.OK],
    [['unhealthy'], ExitCode.UNHEALTHY],
    [['healthy', 'unhealthy'], ExitCode.UNHEALTHY],
    [['recovering'], ExitCode.UNHEALTHY],
  ])('%j -> %i', (statuses, expected) => {
    expect(severityExitCode(statuses as HealthStatus[])).toBe(expected);
  });

  /**
   * A single unmeasurable signal must not fail someone's deploy — that cliff
   * is the whole reason INDETERMINATE is a separate code rather than folding
   * `unknown` into UNHEALTHY. Both sides of the boundary are pinned.
   */
  describe('partial unknown stays OK', () => {
    it.each([
      [['healthy', 'unknown'], ExitCode.OK],
      [['unknown', 'healthy'], ExitCode.OK],
      [Array(9).fill('healthy').concat(['unknown']), ExitCode.OK],
      [['unknown', 'unknown', 'healthy'], ExitCode.OK],
    ])('%j -> %i', (statuses, expected) => {
      expect(severityExitCode(statuses as HealthStatus[])).toBe(expected);
    });
  });

  /**
   * Every evaluated finding unknown = CrisisMode determined nothing at all.
   * That used to exit 0, which a CI gate read as "healthy" — a false green of
   * exactly the shape C8a was about.
   */
  describe('all unknown -> INDETERMINATE', () => {
    it.each([
      [['unknown'], ExitCode.INDETERMINATE],
      [['unknown', 'unknown'], ExitCode.INDETERMINATE],
      [Array(12).fill('unknown'), ExitCode.INDETERMINATE],
    ])('%j -> %i', (statuses, expected) => {
      expect(severityExitCode(statuses as HealthStatus[])).toBe(expected);
    });

    it('never reports INDETERMINATE when something real was measured', () => {
      // Bad news beats "could not check": an unhealthy finding is a definite
      // answer and must win.
      expect(severityExitCode(['unhealthy', 'unknown'])).toBe(ExitCode.UNHEALTHY);
      expect(severityExitCode(['unknown', 'unhealthy'])).toBe(ExitCode.UNHEALTHY);
      expect(severityExitCode(['recovering', 'unknown'])).toBe(ExitCode.UNHEALTHY);
      expect(severityExitCode(['unknown', 'unknown', 'unhealthy'])).toBe(ExitCode.UNHEALTHY);
    });
  });

  /**
   * `[].every()` is vacuously true, so a naive all-unknown check would report
   * INDETERMINATE for a scan with no findings at all. That is a different
   * situation — nothing was *asked* for, rather than nothing being
   * observable — and the no-config onboarding path already guides it. Guarded
   * explicitly rather than left to vacuous truth.
   */
  it('an empty finding set is OK, not INDETERMINATE (no vacuous truth)', () => {
    expect(severityExitCode([])).toBe(ExitCode.OK);
    expect(severityExitCode([])).not.toBe(ExitCode.INDETERMINATE);
  });
});

describe('readinessExitCode', () => {
  /**
   * A fail-open default inside the exit-code layer: an unmapped verdict
   * silently reported success. The Record is exhaustive today, so this is
   * only reachable if the verdict union grows — which is exactly when a
   * silent 0 is most dangerous, because nobody would notice.
   */
  it('does not fail open for an unmapped verdict', () => {
    const unmapped = 'a-verdict-added-later' as ReadinessReport['verdict'];
    expect(readinessExitCode(unmapped)).toBe(ExitCode.INDETERMINATE);
    expect(readinessExitCode(unmapped)).not.toBe(ExitCode.OK);
  });

  it.each([
    ['ready', ExitCode.OK],
    // Consistent with scan/diagnose: a readiness run where nothing could be
    // evaluated is indeterminate, not ready.
    ['unknown', ExitCode.INDETERMINATE],
    ['at-risk', ExitCode.UNHEALTHY],
    ['not-ready', ExitCode.UNHEALTHY],
  ] as const)('%s -> %i', (verdict, expected) => {
    expect(readinessExitCode(verdict)).toBe(expected);
  });
});

describe('runCli exit codes', () => {
  it('returns OK for --help and prints the usage text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runCli(['--help']);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(code).toBe(ExitCode.OK);
    // Asserting only the code would pass if help printed nothing at all.
    expect(printed).toContain('Usage:');
    expect(printed).toContain('Exit codes:');
  });

  it('returns OK for --version and prints a version string', async () => {
    const previous = process.env.__CRISISMODE_VERSION;
    process.env.__CRISISMODE_VERSION = '9.9.9-test';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runCli(['--version']);
    const printed = log.mock.calls.map((c) => String(c[0])).join('');
    log.mockRestore();
    if (previous === undefined) delete process.env.__CRISISMODE_VERSION;
    else process.env.__CRISISMODE_VERSION = previous;
    expect(code).toBe(ExitCode.OK);
    expect(printed).toBe('9.9.9-test');
  });

  it.each([
    [['notacommand']],
    [['scan', '--notaflag']],
    [['--json', 'scan', '--notaflag']],
    [['down', '--bogusflag']],
    // Same class of error as `down --bogusflag`, which already exited 2;
    // a missing required subcommand used to exit 1.
    [['agent']],
    [['playbook']],
    [['registry']],
    [['bundle']],
    [['completions']],
  ])('%j is a usage error (exit 2)', async (argv) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(argv as string[]);
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
  });
});
