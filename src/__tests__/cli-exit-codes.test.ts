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
import { runCli } from '../cli/run.js';
import type { HealthStatus } from '../types/health.js';

describe('ExitCode', () => {
  it('is the single named source of truth for the CLI contract', () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.UNHEALTHY).toBe(1);
    expect(ExitCode.USAGE).toBe(2);
    expect(ExitCode.INTERNAL).toBe(70);
  });
});

describe('severityExitCode', () => {
  it.each([
    [[], ExitCode.OK],
    [['healthy'], ExitCode.OK],
    [['healthy', 'healthy'], ExitCode.OK],
    // `unknown` is "we could not check", not "it is broken" — a kind with no
    // registered agent must not flip a green stack red.
    [['unknown'], ExitCode.OK],
    [['healthy', 'unknown'], ExitCode.OK],
    [['unhealthy'], ExitCode.UNHEALTHY],
    [['healthy', 'unhealthy'], ExitCode.UNHEALTHY],
    [['recovering'], ExitCode.UNHEALTHY],
    [['healthy', 'unknown', 'recovering'], ExitCode.UNHEALTHY],
  ])('%j -> %i', (statuses, expected) => {
    expect(severityExitCode(statuses as HealthStatus[])).toBe(expected);
  });
});

describe('readinessExitCode', () => {
  it.each([
    ['ready', ExitCode.OK],
    ['unknown', ExitCode.OK],
    ['at-risk', ExitCode.UNHEALTHY],
    ['not-ready', ExitCode.UNHEALTHY],
  ] as const)('%s -> %i', (verdict, expected) => {
    expect(readinessExitCode(verdict)).toBe(expected);
  });
});

describe('runCli exit codes', () => {
  it('returns OK for --help and --version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCli(['--help'])).toBe(ExitCode.OK);
    expect(await runCli(['--version'])).toBe(ExitCode.OK);
    log.mockRestore();
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
