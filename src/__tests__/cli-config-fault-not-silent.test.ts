// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * An explicitly named `--config` that cannot be loaded must never look like
 * success.
 *
 * `config/loader.ts` rethrows only `ConfigNotFoundError` and
 * `ConfigValidationError`; every other fault — `EACCES` on the file, a YAML
 * library crash — is swallowed and reported as "no config", so each command
 * quietly carried on against auto-detected services instead. Measured
 * against the built bundle with a `chmod 000` config file:
 *
 *   down      -> EXIT=2  (fixed: the CodeRabbit finding)
 *   scan      -> EXIT=1, no diagnostic  (silently scanned something else)
 *   diagnose  -> EXIT=0, no diagnostic  <-- same class as C8a
 *   triage    -> EXIT=0, no diagnostic
 *   watch     -> started the observation loop
 *
 * `diagnose` exiting 0 for a config the operator explicitly named is the
 * exact ship-blocker this PR exists to remove. The root swallow lives in
 * `src/config/**`, outside this PR's scope, so the guard goes at each CLI
 * boundary: if a path was named and no config came back, that is a failure.
 *
 * Zero-config (no `--config` at all) is a supported mode and must still fall
 * through to auto-detection — asserted below, because that is the flagship
 * behaviour these guards could plausibly break.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CrisisModeError } from '../cli/errors.js';
import type * as LoaderModule from '../config/loader.js';

/**
 * Simulates the swallow: an unexpected fault surfaces as a null config.
 *
 * vi.hoisted — see the note in cli-router-default-arm.test.ts: vi.mock is
 * hoisted above plain module-scope const declarations.
 */
const { loadConfig, loadConfigWithDetection, detectServices } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadConfigWithDetection: vi.fn(),
  detectServices: vi.fn(async () => []),
}));

vi.mock('../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LoaderModule>();
  return { ...actual, loadConfig, loadConfigWithDetection };
});
vi.mock('../cli/detect.js', () => ({ detectServices }));

const { loadConfigWithLocalTargets } = await import('../cli/runtime.js');
const { loadConfigForScan } = await import('../cli/commands/scan.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  detectServices.mockResolvedValue([]);
});

describe('loadConfigWithLocalTargets — used by diagnose and watch', () => {
  it('throws for a named --config that could not be loaded, instead of auto-detecting', async () => {
    // An EACCES inside loadConfig: not one of the two classes it rethrows.
    loadConfig.mockImplementation(() => {
      const err = new Error("EACCES: permission denied, open '/tmp/locked.yaml'") as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    await expect(loadConfigWithLocalTargets({ configPath: '/tmp/locked.yaml' }))
      .rejects.toBeInstanceOf(CrisisModeError);
    await expect(loadConfigWithLocalTargets({ configPath: '/tmp/locked.yaml' }))
      .rejects.toThrow(/\/tmp\/locked\.yaml/);
    // It must not silently probe the machine instead.
    expect(detectServices).not.toHaveBeenCalled();
  });

  it('still auto-detects when no --config was named (zero-config is supported)', async () => {
    loadConfig.mockImplementation(() => { throw new Error('some ambient failure'); });
    detectServices.mockResolvedValue([]);
    const result = await loadConfigWithLocalTargets({});
    expect(result.source).toBe('auto-detected');
    expect(detectServices).toHaveBeenCalled();
  });
});

describe('loadConfigForScan', () => {
  it('throws for a named --config that could not be loaded', () => {
    loadConfigWithDetection.mockReturnValue({ config: null, source: 'none' });
    expect(() => loadConfigForScan('/tmp/locked.yaml')).toThrow(CrisisModeError);
    expect(() => loadConfigForScan('/tmp/locked.yaml')).toThrow(/\/tmp\/locked\.yaml/);
  });

  it('returns the null config when no --config was named (zero-config scan)', () => {
    loadConfigWithDetection.mockReturnValue({ config: null, source: 'none' });
    expect(loadConfigForScan(undefined)).toEqual({ config: null, source: 'none' });
  });

  it('passes a successfully loaded config straight through', () => {
    const loaded = { config: { targets: [] }, source: 'file' as const };
    loadConfigWithDetection.mockReturnValue(loaded);
    expect(loadConfigForScan('/tmp/good.yaml')).toBe(loaded);
  });
});
