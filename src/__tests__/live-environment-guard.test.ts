// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Verifies the environment guard is applied to the diagnose path in the
 * `crisismode recover` / `pnpm run live` flow (src/live.ts).
 *
 * `validatePlan` is mocked to fail, so `runRecovery` returns right after
 * printing the diagnosis (Phase 6 short-circuit) without needing to drive
 * the catalog-match/execution/forensics phases — those aren't part of what
 * this test is proving.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be before imports) ──

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
  parseCliFlags: vi.fn(() => ({})),
}));

vi.mock('../config/credentials.js', () => ({
  validateCredentials: vi.fn(() => []),
}));

vi.mock('../config/agent-registry.js', () => {
  const createForTarget = vi.fn();
  const createFirst = vi.fn();
  const discoverVersion = vi.fn(async () => {});

  class MockAgentRegistry {
    createForTarget = createForTarget;
    createFirst = createFirst;
    static discoverVersion = discoverVersion;
    constructor() {}
  }

  return { AgentRegistry: MockAgentRegistry };
});

vi.mock('../framework/context.js', () => ({
  assembleContext: vi.fn(() => ({
    trigger: { type: 'alert', source: 'prometheus', payload: {}, receivedAt: new Date().toISOString() },
    topology: { source: 'framework_model', staleness: 'PT5M', authoritative: false, components: [] },
  })),
}));

vi.mock('../framework/operator-summary.js', () => ({
  buildOperatorSummary: vi.fn(() => ({
    currentState: 'unhealthy',
    actionRequired: 'investigate',
    recommendedNextStep: 'crisismode recover',
    recommendedActions: [],
  })),
}));

vi.mock('../framework/validator.js', () => ({
  validatePlan: vi.fn(() => ({ valid: false, checks: [] })),
}));

vi.mock('../framework/ai-explainer.js', () => ({
  explainPlan: vi.fn(async () => ({ summary: '', stepExplanations: [], risks: [], source: 'fallback' })),
}));

vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => null),
  probeNetwork: vi.fn(async () => ({
    internet: { status: 'available', probes: [], checkedAt: new Date().toISOString() },
    hub: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
    targets: { status: 'unknown', probes: [], checkedAt: new Date().toISOString() },
    dns: { available: true, latencyMs: 0 },
    mode: 'full',
    profiledAt: new Date().toISOString(),
  })),
}));

// ── Imports ──

import { runRecovery } from '../live.js';
import { configure } from '../cli/output.js';
import { loadConfig } from '../config/loader.js';
import { AgentRegistry } from '../config/agent-registry.js';

// ── Helpers ──

function makeMinimalManifest() {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'AgentManifest' as const,
    metadata: {
      name: 'test-agent',
      version: '1.0.0',
      description: 'Test',
      authors: ['test'],
      license: 'Apache-2.0',
      tags: [],
      plugin: { name: 'test', version: '1.0.0', type: 'agent' as const },
    },
    spec: {
      targetSystems: [{ technology: 'redis', versionConstraint: '>=6' }],
      triggerConditions: [],
      failureScenarios: [],
      executionContexts: [],
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: { maxRiskLevel: 'elevated' as const, dataLossPossible: false, serviceDisruptionPossible: false },
      humanInteraction: { requiresApproval: true, minimumApprovalRole: 'sre', escalationPath: [] },
    },
  };
}

function makeMockTarget() {
  return {
    name: 'test-redis',
    kind: 'redis',
    primary: { host: '127.0.0.1', port: 6379 },
    replicas: [],
    credentials: { type: 'value' as const, username: 'test', password: 'test' },
  };
}

describe('runRecovery (live.ts) environment guard wiring', () => {
  let consoleOutput: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    consoleOutput = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleOutput.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    configure({ json: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reclassifies a name-resolution failure as target_unresolvable before printing the diagnosis', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      config: {
        apiVersion: 'crisismode/v1' as const,
        kind: 'SiteConfig' as const,
        metadata: { name: 'test', environment: 'development' as const },
        targets: [makeMockTarget()],
      },
      source: 'file',
      filePath: 'crisismode.yaml',
    } as never);

    const agent = {
      manifest: makeMinimalManifest(),
      assessHealth: vi.fn(async () => ({
        status: 'unhealthy',
        confidence: 0.9,
        summary: 'unhealthy',
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      })),
      diagnose: vi.fn(async () => ({
        status: 'identified',
        scenario: 'connection_failure',
        confidence: 0.99,
        findings: [{
          source: 'redis_connection',
          observation: 'Redis is unreachable: getaddrinfo ENOTFOUND test-redis.invalid',
          severity: 'critical',
          data: { error: 'getaddrinfo ENOTFOUND test-redis.invalid' },
        }],
        diagnosticPlanNeeded: false,
      })),
      plan: vi.fn(async () => ({
        steps: [],
        rollbackStrategy: { type: 'none' as const, description: 'no rollback needed' },
      })),
    };

    const backend = { close: vi.fn(async () => {}) };
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue({
      agent, backend, target: makeMockTarget(),
    } as never);

    await runRecovery({ execute: false, healthOnly: false });

    const jsonLines = consoleOutput
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean) as Array<Record<string, unknown>>;

    const diagnosisLine = jsonLines.find((l) => l.type === 'diagnosis') as
      { diagnosis: { scenario: string; findings: Array<{ source: string }> } } | undefined;

    expect(diagnosisLine).toBeDefined();
    expect(diagnosisLine!.diagnosis.scenario).toBe('target_unresolvable');
    expect(diagnosisLine!.diagnosis.findings[0]!.source).toBe('environment_check');
  });
});
