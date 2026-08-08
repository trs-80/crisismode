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
import type { TriageReport } from '../framework/triage.js';

// Injected into runScan so its step-0 triage never runs real DNS/gateway/
// portal probes — without this the suite spent ~4.8s per run in live
// network calls and flaked against vitest's 5s default timeout.
const HEALTHY_TRIAGE: TriageReport = {
  verdict: 'healthy',
  explanation: 'test fixture',
  nextStep: 'none',
  observerContext: 'laptop',
  observerContextEvidence: 'test fixture',
  escalationLevel: 2,
  checkedAt: '2026-08-08T12:00:00.000Z',
  durationMs: 1,
  layers: [{ layer: 'interfaces', status: 'pass', detail: 'en0', durationMs: 1 }],
};

// The reviewer's exact repro shape from the Task 6 review (Finding 1): a
// redis-kind target and a services: entry that both resolve to the same
// name. Uses an unregistered, .invalid-TLD name rather than "github" so
// this suite never touches the network: "svc.test.invalid" has no catalog
// entry (no status-page fetch) and .invalid (RFC 2606) fails DNS instantly
// if a probe were ever reached — it collides on a purely literal name match
// (validateNoServiceTargetCollision, config/loader.ts), so the catalog
// membership of the name is irrelevant to the collision behavior under test.
const COLLIDING_CONFIG_YAML = [
  'apiVersion: crisismode/v1',
  'kind: SiteConfig',
  'metadata:',
  '  name: test-site',
  '  environment: development',
  'targets:',
  '  - name: svc.test.invalid',
  '    kind: redis',
  '    primary:',
  '      host: localhost',
  '      port: 6379',
  'services:',
  '  - svc.test.invalid',
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
  // 127.0.0.1:1 refuses instantly (vs. an unresolvable hostname, which made
  // the redis agent burn its full connect timeout and this suite flake
  // against vitest's 5s default).
  '      host: 127.0.0.1',
  '      port: 1',
  'services:',
  '  - svc.test.invalid',
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

    await expect(runScan({ configPath, triageReport: HEALTHY_TRIAGE })).rejects.toThrow(ConfigValidationError);
    await expect(runScan({ configPath, triageReport: HEALTHY_TRIAGE })).rejects.toThrow(/collides/);
  });

  // ~4s is structural, not network flake: the dead redis target burns scan's
  // 2s per-agent cap in both the health and diagnose stages. Bounded, so an
  // explicit timeout (not the 5s default it used to flake against) is the fix.
  it('a non-colliding mixed config still scans both the target and the service (no false rejection)', { timeout: 15_000 }, async () => {
    const configPath = join(tmpDir, 'crisismode.yaml');
    writeFileSync(configPath, NON_COLLIDING_CONFIG_YAML, 'utf-8');

    const result = await runScan({ configPath, category: ['redis', 'service-status'], triageReport: HEALTHY_TRIAGE });

    const services = result.findings.map((f) => f.service);
    expect(services.some((s) => s.includes('redis') && s.includes('my-redis'))).toBe(true);
    expect(services.some((s) => s.includes('service-status') && s.includes('svc.test.invalid'))).toBe(true);
  });
});
