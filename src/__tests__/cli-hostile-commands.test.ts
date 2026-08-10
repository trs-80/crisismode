// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The `CommandName` union was not enforced at runtime.
 *
 * `parseCli` decided validity with `token in COMMAND_OPTIONS`, and `in`
 * matches inherited `Object.prototype` keys — so `toString`, `constructor`,
 * `__proto__`, `valueOf` and `hasOwnProperty` were all accepted as commands
 * and cast to `CommandName`. Observed on the built bundle: instead of
 * "unknown command 'toString'. Did you mean ...?", the operator got
 *
 *   crisismode: COMMAND_OPTIONS[command] is not iterable
 *
 * because `optionsFor` spread `COMMAND_OPTIONS['toString']` — a *function* —
 * and the resulting TypeError was caught by the parser's own catch and
 * reported as a usage message. It exited 2 by accident, leaking a JS
 * internal to the user.
 *
 * The router then trusted the value and relied on switch exhaustiveness with
 * no `default` arm: the compiler's exhaustiveness check cannot protect a
 * value that arrived by a runtime path the type system never validated.
 * That is programming by coincidence, so both halves are fixed — the
 * `Object.hasOwn` guard, and a `default` arm so `runCli` always resolves to
 * a real `ExitCode` and `index.ts` can never assign `process.exitCode =
 * undefined`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExitCode } from '../cli/exit-codes.js';
import { parseCli } from '../cli/args.js';

// vi.hoisted — see the note in cli-router-default-arm.test.ts: vi.mock is
// hoisted above plain const declarations.
const { runScan } = vi.hoisted(() => ({
  runScan: vi.fn(async () => ({ findings: [] as Array<{ status: string }> })),
}));
vi.mock('../cli/commands/scan.js', () => ({ runScan }));

const { runCli } = await import('../cli/run.js');

/** Every own-property-free key an object inherits from Object.prototype. */
const PROTOTYPE_KEYS = [
  'toString',
  'constructor',
  '__proto__',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
] as const;

beforeEach(() => {
  runScan.mockClear();
  runScan.mockResolvedValue({ findings: [] });
});

describe('parseCli — Object.prototype keys are not commands', () => {
  it.each(PROTOTYPE_KEYS)('%s is an unknown command, not a valid one', (key) => {
    const result = parseCli([key]);
    expect(result.kind).toBe('usage');
    if (result.kind !== 'usage') return;
    expect(result.message).toContain(`unknown command '${key}'`);
    // The old failure leaked a JS TypeError from the option-table spread.
    expect(result.message).not.toContain('is not iterable');
    expect(result.message).not.toContain('COMMAND_OPTIONS');
  });

  it('still routes a real command whose name is an own property', () => {
    const result = parseCli(['scan']);
    expect(result.kind).toBe('command');
    if (result.kind === 'command') expect(result.command).toBe('scan');
  });
});

describe('runCli — hostile command tokens always resolve to a real ExitCode', () => {
  it.each(PROTOTYPE_KEYS)('%s exits USAGE and never runs scan', async (key) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli([key]);
    err.mockRestore();
    expect(code).toBe(ExitCode.USAGE);
    expect(runScan).not.toHaveBeenCalled();
  });

  it.each(PROTOTYPE_KEYS)('%s never returns undefined (index.ts must not assign process.exitCode = undefined)', async (key) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli([key]);
    err.mockRestore();
    expect(code).not.toBeUndefined();
    expect(typeof code).toBe('number');
    expect([ExitCode.OK, ExitCode.UNHEALTHY, ExitCode.USAGE, ExitCode.INTERNAL]).toContain(code);
  });
});
