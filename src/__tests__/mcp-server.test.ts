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

vi.mock('../framework/network-profile.js', () => ({
  getNetworkProfile: vi.fn(() => null),
  isInternetAvailable: vi.fn(() => true),
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  handleScan,
  handleDiagnose,
  handleStatus,
  handleListAgents,
} from '../mcp/server.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { loadConfig } from '../config/loader.js';
import { detectServices } from '../cli/detect.js';
import { AgentRegistry } from '../config/agent-registry.js';
import type { AdapterRequest } from '../types/evidence-bundle.js';

// ── Helpers ──

const EXPECTED_TOOLS = [
  'crisismode_bundle_ingest',
  'crisismode_bundle_plan',
  'crisismode_bundle_respond',
  'crisismode_diagnose',
  'crisismode_list_agents',
  'crisismode_readiness',
  'crisismode_scan',
  'crisismode_status',
];

const BUNDLE: AdapterRequest = {
  schema_version: 'incident-generator.agent-adapter-request/v1',
  request_id: 'req-mcp-test',
  benchmark_set_id: 'bench-1',
  case_id: 'case-1',
  created_at: '2026-05-06T00:00:00Z',
  incident_session_id: 'session-1',
  collection_mode: 'fixture',
  input_mode: 'redacted_evidence_bundle',
  skill_domains: ['database'],
  visibility: {
    internal_evidence_roles_visible: false,
    expected_hypotheses_visible: false,
    forbidden_hypotheses_visible: false,
    redaction_required: true,
  },
  evidence_items: [
    {
      evidence_id: 'db.pool.metrics',
      adapter_id: 'database.pool_status',
      title: 'DB pool saturation',
      source_kind: 'metric',
      content_type: 'metric_series',
      content: { format: 'metric_series', body: 'active=95 max=100' },
      time_window: null,
      source_ref: null,
      redacted: true,
      untrusted: false,
    },
  ],
  action_policy: {
    proposed_actions_allowed: true,
    max_action_class: 1,
    allowed_action_classes: [0, 1],
    allowed_action_ids: ['inspect_database_pool'],
    requires_human_approval_for_mutation: true,
  },
  output_contract: {
    response_schema: 'incident-generator.agent-adapter-response/v1',
    required_sections: [
      'hypotheses_ranked',
      'evidence_refs',
      'recommended_next_steps',
      'proposed_actions',
      'abstention',
      'uncertainty',
      'unsafe_actions_avoided',
    ],
  },
};

async function connectedClient() {
  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
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

describe('MCP server (official SDK)', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalEnv) process.env.ANTHROPIC_API_KEY = originalEnv;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  describe('protocol surface', () => {
    it('completes a real MCP handshake and lists all diagnosis tools', async () => {
      const { client, close } = await connectedClient();
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
      } finally {
        await close();
      }
    });

    it('annotates every tool as read-only — the MCP surface must never mutate infrastructure', async () => {
      const { client, close } = await connectedClient();
      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
        }
      } finally {
        await close();
      }
    });

    it('reports tool failures as isError results, not protocol errors', async () => {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({
          name: 'crisismode_bundle_respond',
          arguments: { bundle: 'not json {' },
        });
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }
    });
  });

  describe('crisismode_bundle_respond', () => {
    it('returns a structured abstained AdapterResponse when no API key is set', async () => {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({
          name: 'crisismode_bundle_respond',
          arguments: { bundle: JSON.stringify(BUNDLE) },
        });
        expect(result.isError).toBeFalsy();
        const response = result.structuredContent as Record<string, unknown> & {
          abstention: { abstained: boolean };
        };
        expect(response.schema_version).toBe('incident-generator.agent-adapter-response/v1');
        expect(response.state).toBe('abstained');
        expect(response.request_id).toBe('req-mcp-test');
        expect(response.abstention.abstained).toBe(true);
      } finally {
        await close();
      }
    });

    it('accepts the bundle as a JSON object, not only a string', async () => {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({
          name: 'crisismode_bundle_respond',
          arguments: { bundle: BUNDLE as unknown as Record<string, unknown> },
        });
        expect(result.isError).toBeFalsy();
        const response = result.structuredContent as Record<string, unknown>;
        expect(response.request_id).toBe('req-mcp-test');
      } finally {
        await close();
      }
    });
  });

  describe('crisismode_bundle_ingest', () => {
    it('returns a diagnosis result for a valid bundle', async () => {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({
          name: 'crisismode_bundle_ingest',
          arguments: { bundle: JSON.stringify(BUNDLE) },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeTruthy();
      } finally {
        await close();
      }
    });
  });

  describe('crisismode_bundle_plan', () => {
    it('returns a dry-run recovery plan translation', async () => {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({
          name: 'crisismode_bundle_plan',
          arguments: { bundle: JSON.stringify(BUNDLE) },
        });
        expect(result.isError).toBeFalsy();
        const payload = result.structuredContent as Record<string, unknown>;
        expect(payload).toHaveProperty('plan');
        expect(payload).toHaveProperty('response_state');
      } finally {
        await close();
      }
    });
  });

  describe('crisismode_list_agents', () => {
    it('derives the roster from the real builtin registry, not a hardcoded list', async () => {
      const result = await handleListAgents();
      const data = result as { agents: Array<{ kind: string; name: string; description: string }>; count: number };
      expect(data.count).toBe(builtinAgents.length);
      const kinds = data.agents.map((a) => a.kind);
      for (const registration of builtinAgents) {
        expect(kinds).toContain(registration.kind);
      }
    });

    it('is callable through the protocol', async () => {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({ name: 'crisismode_list_agents', arguments: {} });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { count: number };
        expect(data.count).toBe(builtinAgents.length);
      } finally {
        await close();
      }
    });
  });

  describe('handleScan', () => {
    it('runs scan with config', async () => {
      setupConfig();
      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({ agent, backend, target } as never);

      const data = await handleScan({}) as { score: number; findings: unknown[]; scannedAt: string };
      expect(data.score).toBeDefined();
      expect(data.findings).toBeDefined();
      expect(data.scannedAt).toBeDefined();
    });

    it('falls back to auto-detection when no config', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([
        { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
      ] as never);

      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({ agent, backend, target } as never);

      const data = await handleScan({}) as { findings: unknown[] };
      expect(data.findings).toBeDefined();
    });

    it('returns empty scan when no services detected', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([] as never);

      const data = await handleScan({}) as { score: number; message: string };
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

      const data = await handleScan({}) as { findings: Array<{ status: string; summary: string }> };
      expect(data.findings[0]!.status).toBe('unknown');
      expect(data.findings[0]!.summary).toContain('connection refused');
    });

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
      vi.mocked(loadConfig).mockReturnValue({ config, source: 'file', filePath: 'crisismode.yaml' } as never);

      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createForTarget).mockResolvedValue({
        agent, backend, target: makeMockTarget(),
      } as never);

      const data = await handleScan({ category: 'postgresql' }) as { findings: Array<{ kind: string }> };
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0]!.kind).toBe('postgresql');
    });

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
      vi.mocked(loadConfig).mockReturnValue({ config, source: 'file', filePath: 'crisismode.yaml' } as never);

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

      const data = await handleScan({}) as { score: number };
      expect(data.score).toBe(50);
    });
  });

  describe('handleDiagnose', () => {
    it('runs diagnosis for first target', async () => {
      setupConfig();
      const agent = makeMockAgent();
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createFirst).mockResolvedValue({ agent, backend, target } as never);

      const data = await handleDiagnose({}) as {
        target: string;
        health: { status: string };
        diagnosis: { status: string };
        operatorSummary: { actionRequired: string };
      };
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

      const data = await handleDiagnose({ target: 'test-pg' }) as { target: string };
      expect(data.target).toBe('test-pg');
      expect(vi.mocked(registry.createForTarget)).toHaveBeenCalledWith('test-pg');
    });

    it('closes backend even on error, surfacing isError through the protocol', async () => {
      setupConfig();
      const agent = makeMockAgent();
      agent.assessHealth.mockRejectedValue(new Error('diagnosis engine crashed'));
      const backend = makeMockBackend();
      const target = makeMockTarget();

      const registry = new AgentRegistry({} as never);
      vi.mocked(registry.createFirst).mockResolvedValue({ agent, backend, target } as never);

      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({ name: 'crisismode_diagnose', arguments: {} });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text).toContain('diagnosis engine crashed');
        expect(backend.close).toHaveBeenCalled();
      } finally {
        await close();
      }
    });
  });

  describe('handleStatus', () => {
    it('returns status from config targets', async () => {
      setupConfig();
      const data = await handleStatus({}) as { services: Array<{ kind: string }>; checkedAt: string };
      expect(data.services).toHaveLength(1);
      expect(data.services[0]!.kind).toBe('postgresql');
      expect(data.checkedAt).toBeDefined();
    });

    it('falls back to detection when no config', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([
        { kind: 'redis', host: '127.0.0.1', port: 6379, detected: true },
      ] as never);

      const data = await handleStatus({}) as { services: Array<{ kind: string; detected?: boolean }> };
      expect(data.services[0]!.kind).toBe('redis');
    });

    it('preserves detected flags from detection', async () => {
      vi.mocked(loadConfig).mockImplementation(() => { throw new Error('not found'); });
      vi.mocked(detectServices).mockResolvedValue([
        { kind: 'postgresql', host: '127.0.0.1', port: 5432, detected: true },
        { kind: 'redis', host: '127.0.0.1', port: 6379, detected: false },
      ] as never);

      const data = await handleStatus({}) as { services: Array<{ detected: boolean }> };
      expect(data.services).toHaveLength(2);
      expect(data.services[0]!.detected).toBe(true);
      expect(data.services[1]!.detected).toBe(false);
    });
  });
});
