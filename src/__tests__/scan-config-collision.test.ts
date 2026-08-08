// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Round 2 fix (Task 6 review, re-review Medium 1): `runScan` used to
 * silently discard a config that was found but rejected by loader.ts's
 * validation — including the services:/targets: name-collision check — and
 * fall back to auto-detecting localhost, without ever mentioning the error.
 * These tests drive the real `runScan` command surface (not `loadConfig`
 * directly) against a real config file on disk, following the same
 * real-file + mocked-autodiscovery harness as
 * scan-run-best-effort.test.ts, so the regression is caught at the layer an
 * operator actually experiences it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../cli/autodiscovery.js', () => ({
  discoverStack: vi.fn(async () => ({
    services: [],
    appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    envHints: [],
    platform: { platform: null, detected: false, signals: [] },
    aiProviders: [],
    derivedTargets: [],
    derivedNotes: {},
    confidence: 0.5,
  })),
  printOnboardingMessage: vi.fn(),
}));
vi.mock('../framework/check-discovery.js', () => ({
  discoverCheckPlugins: vi.fn(async () => ({ plugins: [], warnings: [] })),
}));

import { runScan } from '../cli/commands/scan.js';
import { ConfigValidationError } from '../config/loader.js';

// The reviewer's exact repro shape from the Task 6 review (Finding 1): a
// redis-kind target and a services: entry that both resolve to "github".
const COLLIDING_CONFIG_YAML = [
  'apiVersion: crisismode/v1',
  'kind: SiteConfig',
  'metadata:',
  '  name: test-site',
  '  environment: development',
  'targets:',
  '  - name: github',
  '    kind: redis',
  '    primary:',
  '      host: localhost',
  '      port: 6379',
  'services:',
  '  - github',
  '',
].join('\n');

// A non-colliding mixed config — targets and services present, no name overlap.
const NON_COLLIDING_CONFIG_YAML = [
  'apiVersion: crisismode/v1',
  'kind: SiteConfig',
  'metadata:',
  '  name: test-site',
  '  environment: development',
  'targets:',
  '  - name: my-redis',
  '    kind: redis',
  '    primary:',
  '      host: simulator',
  '      port: 6379',
  'services:',
  '  - github',
  '',
].join('\n');

describe('runScan — services/targets name collision surfaces to the caller', () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crisismode-scan-collision-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects with ConfigValidationError naming the collision, instead of silently auto-detecting', async () => {
    const configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, COLLIDING_CONFIG_YAML, 'utf-8');

    await expect(runScan({ configPath })).rejects.toThrow(ConfigValidationError);
    await expect(runScan({ configPath })).rejects.toThrow(/collides/);
  });

  it('a non-colliding mixed config still scans both the target and the service (no false rejection)', async () => {
    const configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, NON_COLLIDING_CONFIG_YAML, 'utf-8');

    const result = await runScan({ configPath, category: ['redis', 'service-status'] });

    const services = result.findings.map((f) => f.service);
    expect(services.some((s) => s.includes('redis') && s.includes('my-redis'))).toBe(true);
    expect(services.some((s) => s.includes('service-status') && s.includes('github'))).toBe(true);
  });
});
