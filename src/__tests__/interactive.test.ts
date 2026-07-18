// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Verifies the environment guard is applied to the diagnose path used by
 * `crisismode` zero-arg interactive mode (src/cli/interactive.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be before imports) ──

vi.mock('../cli/output.js', () => ({
  printBanner: vi.fn(),
  printDetection: vi.fn(),
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  printWarning: vi.fn(),
  printHealthStatus: vi.fn(),
  printDiagnosis: vi.fn(),
  printPlan: vi.fn(),
  printOperatorSummary: vi.fn(),
}));

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../framework/context.js', () => ({
  assembleContext: vi.fn(() => ({
    trigger: { type: 'alert', source: 'cli-interactive', payload: {}, receivedAt: new Date().toISOString() },
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
  validatePlan: vi.fn(() => ({ valid: true, checks: [] })),
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

vi.mock('../config/agent-registry.js', () => {
  const createForTarget = vi.fn();
  const discoverVersion = vi.fn(async () => {});

  class MockAgentRegistry {
    createForTarget = createForTarget;
    static discoverVersion = discoverVersion;
    constructor() {}
  }

  return { AgentRegistry: MockAgentRegistry };
});

// ── Imports ──

import { runInteractive } from '../cli/interactive.js';
import { loadConfig } from '../config/loader.js';
import { AgentRegistry } from '../config/agent-registry.js';
import { printDiagnosis } from '../cli/output.js';

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
      targetSystems: [{ technology: 'postgresql', versionConstraint: '>=14' }],
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
    name: 'test-pg',
    kind: 'postgresql',
    primary: { host: '127.0.0.1', port: 5432 },
    replicas: [],
    credentials: { type: 'value' as const, username: 'test', password: 'test' },
  };
}

describe('runInteractive environment guard wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
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
        scenario: 'database_unreachable',
        confidence: 0.99,
        findings: [{
          source: 'pg_connection',
          observation: 'PostgreSQL is unreachable: getaddrinfo ENOTFOUND test-pg.invalid',
          severity: 'critical',
          data: { error: 'getaddrinfo ENOTFOUND test-pg.invalid' },
        }],
        diagnosticPlanNeeded: false,
      })),
      plan: vi.fn(async () => ({
        apiVersion: 'crisismode/v1',
        kind: 'RecoveryPlan' as const,
        metadata: {
          planId: 'test-plan',
          agentName: 'test-agent',
          agentVersion: '1.0.0',
          scenario: 'database_unreachable',
          createdAt: new Date().toISOString(),
          estimatedDuration: 'PT5M',
          summary: 'test plan',
          supersedes: null,
        },
        impact: { affectedSystems: [], affectedServices: [], estimatedUserImpact: 'none', dataLossRisk: 'none' },
        steps: [],
        rollbackStrategy: { type: 'none' as const, description: 'no rollback needed' },
      })),
    };

    const backend = { close: vi.fn(async () => {}) };
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createForTarget).mockResolvedValue({
      agent, backend, target: makeMockTarget(),
    } as never);

    await runInteractive();

    expect(vi.mocked(printDiagnosis)).toHaveBeenCalledTimes(1);
    const [reportedDiagnosis] = vi.mocked(printDiagnosis).mock.calls[0] as [{
      scenario: string;
      status: string;
      findings: Array<{ source: string }>;
    }, ...unknown[]];
    expect(reportedDiagnosis.scenario).toBe('target_unresolvable');
    expect(reportedDiagnosis.findings[0]!.source).toBe('environment_check');
  });
});
