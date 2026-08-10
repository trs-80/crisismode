// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The router's `default` arm — the belt-and-braces half of the
 * runtime-vs-type-system gap.
 *
 * `parseCli` now rejects anything that is not an own property of
 * `COMMAND_OPTIONS`, so in normal operation the switch in `runCli` is
 * genuinely exhaustive. But TypeScript's exhaustiveness check only holds if
 * the value really is a `CommandName`, and `command` reaches the switch
 * through a runtime path (a string from argv, narrowed by a cast). If that
 * guard is ever weakened, the switch would fall through and `runCli` would
 * resolve to `undefined`, which `index.ts` would assign to
 * `process.exitCode` — silently exiting 0 for an unroutable command.
 *
 * This test forces exactly that state by stubbing the parser, which is the
 * only way to reach the arm. It fails if the `default` arm is removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExitCode } from '../cli/exit-codes.js';
import type * as ArgsModule from '../cli/args.js';

const parseCli = vi.fn();
vi.mock('../cli/args.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ArgsModule>();
  return { ...actual, parseCli };
});

const runScan = vi.fn(async () => ({ findings: [] as Array<{ status: string }> }));
vi.mock('../cli/commands/scan.js', () => ({ runScan }));

const { runCli } = await import('../cli/run.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runCli — the default arm', () => {
  it('returns USAGE for a command the parser let through but the router does not handle', async () => {
    parseCli.mockReturnValue({
      kind: 'command',
      command: 'a-command-that-does-not-exist',
      values: {},
      positionals: [],
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(['whatever']);
    const message = err.mock.calls.map((c) => c.join(' ')).join('\n');
    err.mockRestore();

    // The invariant index.ts depends on: never undefined.
    expect(code).not.toBeUndefined();
    expect(code).toBe(ExitCode.USAGE);
    expect(message).toContain('a-command-that-does-not-exist');
    expect(runScan).not.toHaveBeenCalled();
  });

  it('still dispatches normally when the parser returns a real command', async () => {
    parseCli.mockReturnValue({
      kind: 'command',
      command: 'scan',
      values: {},
      positionals: [],
    });
    runScan.mockResolvedValue({ findings: [] });
    expect(await runCli(['scan'])).toBe(ExitCode.OK);
    expect(runScan).toHaveBeenCalled();
  });
});
