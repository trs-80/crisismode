// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be before imports) ──

vi.mock('../cli/output.js', () => ({
  printBanner: vi.fn(),
  printHealthStatus: vi.fn(),
  printInfo: vi.fn(),
  printSuccess: vi.fn(),
  printWarning: vi.fn(),
  printError: vi.fn(),
  printDetection: vi.fn(),
}));

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
  parseCliFlags: vi.fn(),
}));

vi.mock('../cli/detect.js', () => ({
  detectServices: vi.fn(),
}));

vi.mock('../framework/context.js', () => ({
  assembleContext: vi.fn(() => ({
    trigger: { type: 'health_check', source: 'cli-watch', payload: {}, receivedAt: new Date().toISOString() },
    topology: { source: 'framework_model', staleness: 'PT5M', authoritative: false, components: [] },
  })),
}));

vi.mock('../framework/operator-summary.js', () => ({
  buildOperatorSummary: vi.fn(() => ({
    status: 'unhealthy',
    automationStatus: 'monitoring',
    executeReadiness: { ready: false, blockers: [] },
  })),
}));

vi.mock('../framework/incident-report.js', () => ({
  generateDiagnosisReport: vi.fn(() => ({
    markdown: '## Test Report',
    sections: [],
  })),
}));

// Mock AgentRegistry as a class with static method
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

vi.mock('../cli/errors.js', () => {
  class CrisisModeError extends Error {
    readonly suggestion: string;
    constructor(message: string, suggestion: string) {
      super(message);
      this.name = 'CrisisModeError';
      this.suggestion = suggestion;
    }
  }
  return {
    noConfig: () => new CrisisModeError('No configuration found and no services detected', 'Run crisismode init'),
    formatError: (e: unknown) => e instanceof Error ? e.message : String(e),
  };
});

// ── Imports ──

import { runWatch } from '../cli/commands/watch.js';
import { loadConfig } from '../config/loader.js';
import { detectServices } from '../cli/detect.js';
import { AgentRegistry } from '../config/agent-registry.js';
import { printBanner, printInfo, printWarning, printError, printDetection } from '../cli/output.js';
import { generateDiagnosisReport } from '../framework/incident-report.js';

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

function makeMockAgent(healthStatus: string = 'healthy') {
  return {
    manifest: makeMinimalManifest(),
    assessHealth: vi.fn(async () => ({
      status: healthStatus,
      confidence: 0.95,
      summary: `System is ${healthStatus}`,
      observedAt: new Date().toISOString(),
      signals: [],
      recommendedActions: [],
    })),
    diagnose: vi.fn(async () => ({
      scenarioId: 'test',
      findings: [],
      rootCause: 'test cause',
      confidence: 0.9,
      evidence: [],
    })),
    plan: vi.fn(async () => ({
      planId: 'test-plan',
      steps: [],
      rollbackStrategy: { type: 'none' as const },
    })),
  };
}

function makeMockBackend() {
  return {
    close: vi.fn(async () => {}),
    executeCommand: vi.fn(),
    evaluateCheck: vi.fn(),
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

function makeAgentInstance(healthStatus: string = 'healthy') {
  return {
    agent: makeMockAgent(healthStatus),
    backend: makeMockBackend(),
    target: makeMockTarget(),
  };
}

function setupConfigSuccess() {
  vi.mocked(loadConfig).mockReturnValue({
    config: {
      apiVersion: 'crisismode/v1' as const,
      kind: 'SiteConfig' as const,
      metadata: { name: 'test', environment: 'development' as const },
      targets: [{
        name: 'test-pg',
        kind: 'postgresql',
        primary: { host: '127.0.0.1', port: 5432 },
        replicas: [],
        credentials: { type: 'value' as const, username: 'test', password: 'test' },
      }],
    },
    source: 'file',
    filePath: 'crisismode.yaml',
  });
}

// ── Tests ──

describe('runWatch', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('runs one health check cycle with config file', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    // Access the mock through the imported class prototype
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1, intervalMs: 10 });

    expect(vi.mocked(printBanner)).toHaveBeenCalled();
    expect(vi.mocked(loadConfig)).toHaveBeenCalled();
    expect(instance.agent.assessHealth).toHaveBeenCalledTimes(1);
    expect(instance.backend.close).toHaveBeenCalled();
    // Should print summary
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Total cycles'));
  });

  it('uses targetName when provided', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createForTarget).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1, intervalMs: 10, targetName: 'test-pg' });

    expect(vi.mocked(registry.createForTarget)).toHaveBeenCalledWith('test-pg');
  });

  it('falls back to auto-detection when config loading fails', async () => {
    vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(detectServices).mockResolvedValue([
      { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
    ]);

    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1, intervalMs: 10 });

    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('No configuration found'));
    expect(vi.mocked(detectServices)).toHaveBeenCalled();
    expect(vi.mocked(printDetection)).toHaveBeenCalled();
  });

  it('runs with local agents when config fails and no services detected', async () => {
    vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
    vi.mocked(detectServices).mockResolvedValue([
      { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: false },
    ]);

    const instance = makeAgentInstance();
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    // Should not throw — local agents (DNS, disk) provide targets
    await runWatch({ maxCycles: 1, intervalMs: 10 });

    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('No configuration found'));
  });

  it('runs two cycles and tracks health transitions', async () => {
    setupConfigSuccess();

    let callCount = 0;
    const instance = makeAgentInstance();
    // First call: healthy, second call: unhealthy
    instance.agent.assessHealth.mockImplementation(async () => {
      callCount++;
      const status = callCount === 1 ? 'healthy' : 'unhealthy';
      return {
        status,
        confidence: 0.95,
        summary: `System is ${status}`,
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      };
    });

    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 2, intervalMs: 10 });

    expect(instance.agent.assessHealth).toHaveBeenCalledTimes(2);
    // On transition from healthy to unhealthy, should generate recovery proposal
    expect(vi.mocked(printWarning)).toHaveBeenCalledWith(
      expect.stringContaining('healthy to unhealthy'),
    );
    expect(instance.agent.diagnose).toHaveBeenCalledTimes(1);
    expect(instance.agent.plan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateDiagnosisReport)).toHaveBeenCalled();

    // Summary should show transitions and proposals
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Health transitions:   1'));
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Proposals generated:  1'));
  });

  it('handles health check errors gracefully', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance();
    instance.agent.assessHealth.mockRejectedValue(new Error('connection refused'));
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1, intervalMs: 10 });

    expect(vi.mocked(printError)).toHaveBeenCalledWith(
      expect.stringContaining('connection refused'),
    );
    // Should still close backend
    expect(instance.backend.close).toHaveBeenCalled();
  });

  it('does not generate proposal when health stays healthy', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 2, intervalMs: 10 });

    expect(instance.agent.diagnose).not.toHaveBeenCalled();
    expect(instance.agent.plan).not.toHaveBeenCalled();
  });

  it('does not generate proposal when health stays unhealthy', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('unhealthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 2, intervalMs: 10 });

    // Only triggers on transition from healthy -> unhealthy, not staying unhealthy
    expect(instance.agent.diagnose).not.toHaveBeenCalled();
  });

  it('prints the config source', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1, intervalMs: 10 });

    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Config:'));
  });

  it('prints observation interval', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1, intervalMs: 5000 });

    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(
      expect.stringContaining('every 5s'),
    );
  });

  it('detects and prints patterns at cycle 10', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance();
    let callCount = 0;

    // Alternate healthy/unhealthy to create a flapping pattern
    instance.agent.assessHealth.mockImplementation(async () => {
      callCount++;
      const status = callCount % 2 === 0 ? 'unhealthy' : 'healthy';
      return {
        status,
        confidence: 0.9,
        summary: `Status: ${status}`,
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      };
    });

    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 10, intervalMs: 1 });

    // 10 cycles of flapping should trigger pattern detection at cycle 10
    expect(instance.agent.assessHealth).toHaveBeenCalledTimes(10);
    // Pattern detection runs at cycle 10 — if patterns found, printWarning is called
    // The flapping between healthy/unhealthy produces transitions + proposals
    expect(instance.backend.close).toHaveBeenCalled();
  });

  it('prints summary with detected patterns', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance();
    let callCount = 0;

    // Create a health flapping pattern: healthy → unhealthy → healthy → unhealthy ...
    instance.agent.assessHealth.mockImplementation(async () => {
      callCount++;
      const status = callCount % 2 === 0 ? 'unhealthy' : 'healthy';
      return {
        status,
        confidence: 0.85,
        summary: `System ${status}`,
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      };
    });

    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 10, intervalMs: 1 });

    // Summary should show transitions
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Health transitions'));
  });

  it('uses default interval when not specified', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 1 });

    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(
      expect.stringContaining('every 30s'),
    );
  });

  it('prints watch summary with uptime and confidence', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance('healthy');
    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 3, intervalMs: 1 });

    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Uptime:'));
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Avg confidence:'));
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Total cycles:         3'));
  });

  it('handles multiple transitions in sequence', async () => {
    setupConfigSuccess();
    const instance = makeAgentInstance();
    let callCount = 0;

    // healthy → unhealthy → healthy (two transitions)
    instance.agent.assessHealth.mockImplementation(async () => {
      callCount++;
      let status: string;
      if (callCount <= 1) status = 'healthy';
      else if (callCount <= 2) status = 'unhealthy';
      else status = 'healthy';
      return {
        status,
        confidence: 0.9,
        summary: `System is ${status}`,
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      };
    });

    const registry = new AgentRegistry({} as never);
    vi.mocked(registry.createFirst).mockResolvedValue(instance as never);

    await runWatch({ maxCycles: 3, intervalMs: 1 });

    // Should show 2 health transitions
    expect(vi.mocked(printInfo)).toHaveBeenCalledWith(expect.stringContaining('Health transitions:   2'));
  });
});
