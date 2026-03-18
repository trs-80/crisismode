// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (before imports) ──

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
  parseCliFlags: vi.fn(),
}));

vi.mock('../cli/detect.js', () => ({
  detectServices: vi.fn(),
}));

vi.mock('../config/agent-registry.js', () => {
  const createForTarget = vi.fn();
  const createFirst = vi.fn();
  const discoverVersion = vi.fn(async () => {});

  class MockAgentRegistry {
    config: unknown;
    createForTarget = createForTarget;
    createFirst = createFirst;
    static discoverVersion = discoverVersion;
    constructor(config: unknown) { this.config = config; }
  }

  return { AgentRegistry: MockAgentRegistry };
});

vi.mock('../framework/context.js', () => ({
  assembleContext: vi.fn(() => ({
    trigger: { type: 'health_check', source: 'mcp', payload: {}, receivedAt: new Date().toISOString() },
    topology: { source: 'framework_model', staleness: 'PT5M', authoritative: false, components: [] },
  })),
}));

vi.mock('../framework/operator-summary.js', () => ({
  buildOperatorSummary: vi.fn(() => ({
    currentState: 'healthy',
    actionRequired: 'none',
    recommendedNextStep: 'Continue monitoring',
    recommendedActions: [],
  })),
}));

// ── Imports ──

import {
  handleJsonRpcRequest,
  buildInitializeResult,
  TOOL_DEFINITIONS,
  handleListAgents,
} from '../mcp/server.js';
import type { JsonRpcRequest } from '../mcp/server.js';
import { loadConfig } from '../config/loader.js';
import { detectServices } from '../cli/detect.js';
import { AgentRegistry } from '../config/agent-registry.js';

// ── Helpers ──

function makeRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

function makeMinimalManifest() {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'AgentManifest' as const,
    metadata: {
      name: 'test-agent', version: '1.0.0', description: 'Test',
      authors: ['test'], license: 'Apache-2.0', tags: [],
      plugin: { name: 'test', version: '1.0.0', type: 'agent' as const },
    },
    spec: {
      targetSystems: [{ technology: 'postgresql', versionConstraint: '>=14' }],
      triggerConditions: [], failureScenarios: [], executionContexts: [],
      observabilityDependencies: { required: [], optional: [] },
      riskProfile: { maxRiskLevel: 'elevated' as const, dataLossPossible: false, serviceDisruptionPossible: false },
      humanInteraction: { requiresApproval: true, minimumApprovalRole: 'sre', escalationPath: [] },
    },
  };
}

function makeMockAgent() {
  return {
    manifest: makeMinimalManifest(),
    assessHealth: vi.fn(async () => ({
      status: 'healthy',
      confidence: 0.95,
      summary: 'All good',
      observedAt: new Date().toISOString(),
      signals: [{ source: 'test', status: 'healthy' as const, detail: 'OK', observedAt: new Date().toISOString() }],
      recommendedActions: [],
    })),
    diagnose: vi.fn(async () => ({
      status: 'identified' as const,
      scenario: 'normal',
      confidence: 0.9,
      findings: [{ source: 'test', observation: 'System nominal', severity: 'info' as const }],
      diagnosticPlanNeeded: false,
    })),
    plan: vi.fn(async () => ({ steps: [], rollbackStrategy: { type: 'none' as const } })),
  };
}

function makeMockBackend() {
  return { close: vi.fn(async () => {}), executeCommand: vi.fn(), evaluateCheck: vi.fn() };
}

function makeMockTarget() {
  return {
    name: 'test-pg', kind: 'postgresql',
    primary: { host: '127.0.0.1', port: 5432 },
    replicas: [],
    credentials: { type: 'value' as const, username: 'test', password: 'test' },
  };
}

function setupConfig() {
  vi.mocked(loadConfig).mockReturnValue({
    config: {
      apiVersion: 'crisismode/v1' as const,
      kind: 'SiteConfig' as const,
      metadata: { name: 'test', environment: 'development' as const },
      targets: [makeMockTarget()],
    },
    source: 'file',
    filePath: 'crisismode.yaml',
  });
}

// ── Tests ──

describe('MCP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildInitializeResult', () => {
    it('returns server info with name and version', () => {
      const info = buildInitializeResult();
      expect(info.name).toBe('crisismode');
      expect(info.version).toBe('0.2.0');
      expect(info.capabilities.tools).toBeDefined();
    });
  });

  describe('TOOL_DEFINITIONS', () => {
    it('defines 4 tools', () => {
      expect(TOOL_DEFINITIONS).toHaveLength(4);
    });

    it('all tools have required fields', () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.name).toBeDefined();
        expect(tool.name.startsWith('crisismode_')).toBe(true);
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('includes scan, diagnose, status, and list_agents', () => {
      const names = TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toContain('crisismode_scan');
      expect(names).toContain('crisismode_diagnose');
      expect(names).toContain('crisismode_status');
      expect(names).toContain('crisismode_list_agents');
    });
  });

  describe('handleJsonRpcRequest', () => {
    it('handles initialize', async () => {
      const response = await handleJsonRpcRequest(makeRequest('initialize'));
      expect(response.result).toBeDefined();
      const result = response.result as { name: string };
      expect(result.name).toBe('crisismode');
    });

    it('handles tools/list', async () => {
      const response = await handleJsonRpcRequest(makeRequest('tools/list'));
      expect(response.result).toBeDefined();
      const result = response.result as { tools: unknown[] };
      expect(result.tools).toHaveLength(4);
    });

    it('returns error for unknown method', async () => {
      const response = await handleJsonRpcRequest(makeRequest('unknown/method'));
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
      expect(response.error!.message).toContain('Method not found');
    });

    it('returns error for unknown tool', async () => {
      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'unknown_tool', arguments: {} }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
      expect(response.error!.message).toContain('Unknown tool');
    });

    it('handles notifications/initialized', async () => {
      const response = await handleJsonRpcRequest(makeRequest('notifications/initialized'));
      expect(response.result).toBeDefined();
    });

    it('preserves request id in response', async () => {
      const response = await handleJsonRpcRequest(makeRequest('initialize', {}, 42));
      expect(response.id).toBe(42);
      expect(response.jsonrpc).toBe('2.0');
    });

    it('handles string ids', async () => {
      const response = await handleJsonRpcRequest(makeRequest('initialize', {}, 'req-abc'));
      expect(response.id).toBe('req-abc');
    });
  });

  describe('tools/call — crisismode_scan', () => {
    it('runs scan with config', async () => {
      setupConfig();
      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_scan', arguments: {} }),
      );

      expect(response.result).toBeDefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      expect(data.score).toBeDefined();
      expect(data.findings).toBeDefined();
      expect(data.scannedAt).toBeDefined();
    });

    it('falls back to auto-detection when no config', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([
        { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
      ]);

      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_scan', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.findings).toBeDefined();
    });

    it('returns empty scan when no services detected', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([]);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_scan', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.score).toBe(100);
      expect(data.message).toContain('No services detected');
    });

    it('handles health check failures gracefully', async () => {
      setupConfig();
      const agent = makeMockAgent();
      agent.assessHealth.mockRejectedValue(new Error('connection refused'));
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_scan', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.findings[0].status).toBe('unknown');
      expect(data.findings[0].summary).toContain('connection refused');
    });
  });

  describe('tools/call — crisismode_diagnose', () => {
    it('runs diagnosis for first target', async () => {
      setupConfig();
      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createFirst).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_diagnose', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.target).toBe('test-pg');
      expect(data.health.status).toBe('healthy');
      expect(data.diagnosis.status).toBe('identified');
      expect(data.operatorSummary.actionRequired).toBeDefined();
      expect(backend.close).toHaveBeenCalled();
    });

    it('diagnoses specific target', async () => {
      setupConfig();
      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', {
          name: 'crisismode_diagnose',
          arguments: { target: 'test-pg' },
        }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.target).toBe('test-pg');
      expect(vi.mocked(registry.createForTarget)).toHaveBeenCalledWith('test-pg');
    });

    it('closes backend even on error', async () => {
      setupConfig();
      const agent = makeMockAgent();
      agent.assessHealth.mockRejectedValue(new Error('fail'));
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createFirst).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_diagnose', arguments: {} }),
      );

      // Should return error content
      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(backend.close).toHaveBeenCalled();
    });
  });

  describe('tools/call — crisismode_status', () => {
    it('returns status from config targets', async () => {
      setupConfig();

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_status', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.services).toHaveLength(1);
      expect(data.services[0].kind).toBe('postgresql');
      expect(data.checkedAt).toBeDefined();
    });

    it('falls back to detection when no config', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([
        { kind: 'redis', host: '127.0.0.1', port: 6379, detected: true },
      ]);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_status', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.services[0].kind).toBe('redis');
    });
  });

  describe('tools/call — crisismode_list_agents', () => {
    it('returns all built-in agents', async () => {
      const result = await handleListAgents();
      const agents = result as { agents: Array<{ kind: string; name: string }>; count: number };
      expect(agents.count).toBe(12);
      expect(agents.agents.map((a) => a.kind)).toContain('postgresql');
      expect(agents.agents.map((a) => a.kind)).toContain('redis');
      expect(agents.agents.map((a) => a.kind)).toContain('kafka');
      expect(agents.agents.map((a) => a.kind)).toContain('kubernetes');
    });

    it('works via JSON-RPC', async () => {
      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_list_agents', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.agents).toHaveLength(12);
    });
  });

  describe('tools/call — crisismode_scan with category filter', () => {
    it('filters by category', async () => {
      const config = {
        apiVersion: 'crisismode/v1' as const,
        kind: 'SiteConfig' as const,
        metadata: { name: 'test', environment: 'development' as const },
        targets: [
          makeMockTarget(),
          { ...makeMockTarget(), name: 'test-redis', kind: 'redis', primary: { host: '127.0.0.1', port: 6379 } },
        ],
      };
      vi.mocked(loadConfig).mockReturnValue({ config, source: 'file', filePath: 'crisismode.yaml' });

      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({
        agent, backend, target: makeMockTarget(),
      } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', {
          name: 'crisismode_scan',
          arguments: { category: 'postgresql' },
        }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      // Only postgresql target scanned, redis filtered out
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].kind).toBe('postgresql');
    });
  });

  describe('tools/call — crisismode_scan score calculation', () => {
    it('computes score based on healthy/total ratio', async () => {
      const config = {
        apiVersion: 'crisismode/v1' as const,
        kind: 'SiteConfig' as const,
        metadata: { name: 'test', environment: 'development' as const },
        targets: [
          makeMockTarget(),
          { ...makeMockTarget(), name: 'test-pg2', kind: 'postgresql' },
        ],
      };
      vi.mocked(loadConfig).mockReturnValue({ config, source: 'file', filePath: 'crisismode.yaml' });

      let callNum = 0;
      const agent = makeMockAgent();
      agent.assessHealth.mockImplementation(async () => {
        callNum++;
        return {
          status: callNum === 1 ? 'healthy' : 'unhealthy',
          confidence: 0.9,
          summary: 'test',
          observedAt: new Date().toISOString(),
          signals: [],
          recommendedActions: [],
        };
      });
      const backend = makeMockBackend();
      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({
        agent, backend, target: makeMockTarget(),
      } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_scan', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      // 1 healthy out of 2 = 50%
      expect(data.score).toBe(50);
    });
  });

  describe('tools/call — crisismode_status', () => {
    it('returns services from detection with detected flag', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([
        { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
        { kind: 'redis', host: '127.0.0.1', port: 6379, detected: false },
      ]);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_status', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }> };
      const data = JSON.parse(result.content[0].text);
      expect(data.services).toHaveLength(2);
      expect(data.services[0].detected).toBe(true);
      expect(data.services[1].detected).toBe(false);
    });
  });

  describe('tools/call — crisismode_diagnose error handling', () => {
    it('wraps handler errors in isError content', async () => {
      setupConfig();
      const agent = makeMockAgent();
      agent.assessHealth.mockResolvedValue({
        status: 'unhealthy' as const,
        confidence: 0.9,
        summary: 'Database down',
        observedAt: new Date().toISOString(),
        signals: [],
        recommendedActions: [],
      });
      agent.diagnose.mockRejectedValue(new Error('diagnosis engine crashed'));
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createFirst).mockResolvedValue({ agent, backend, target } as never);

      const response = await handleJsonRpcRequest(
        makeRequest('tools/call', { name: 'crisismode_diagnose', arguments: {} }),
      );

      const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('diagnosis engine crashed');
    });
  });
});
