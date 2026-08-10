// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode --version` when the version was NOT inlined at bundle time.
 *
 * esbuild replaces `process.env.__CRISISMODE_VERSION` in the shipped bundle,
 * so this path only runs from a source checkout — where it reads
 * package.json, and falls back to the literal string "unknown" if that read
 * or parse fails. Isolated in its own file because it mocks `node:fs`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExitCode } from '../cli/exit-codes.js';
import type * as FsModule from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('package.json')) {
        throw new Error('ENOENT: no such file or directory');
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { runCli } = await import('../cli/run.js');

let previous: string | undefined;

beforeEach(() => {
  previous = process.env.__CRISISMODE_VERSION;
  delete process.env.__CRISISMODE_VERSION;
});

afterEach(() => {
  if (previous === undefined) delete process.env.__CRISISMODE_VERSION;
  else process.env.__CRISISMODE_VERSION = previous;
  vi.restoreAllMocks();
});

describe('runCli --version fallback', () => {
  it('prints "unknown" and still exits OK when package.json cannot be read', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runCli(['--version']);
    const printed = log.mock.calls.map((c) => String(c[0])).join('');
    log.mockRestore();
    // Not a crash and not a non-zero exit: `--version` failing to find its
    // own package.json is not the user's problem and not an outage.
    expect(code).toBe(ExitCode.OK);
    expect(printed).toBe('unknown');
  });
});
