// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CrisisMode MCP (Model Context Protocol) Server
 *
 * Exposes CrisisMode capabilities as MCP tools, allowing AI assistants
 * and other MCP clients to invoke health scans, diagnostics, and
 * watch status queries.
 *
 * Protocol: JSON-RPC 2.0 over stdio (stdin/stdout).
 * Spec: https://modelcontextprotocol.io
 *
 * Tools exposed:
 * - crisismode_scan — run a zero-config health scan
 * - crisismode_diagnose — diagnose a specific target
 * - crisismode_status — quick health status probe
 * - crisismode_watch_status — get current watch-mode health card
 * - crisismode_list_agents — list available recovery agents
 */

import { loadConfig } from '../config/loader.js';
import { AgentRegistry } from '../config/agent-registry.js';
import { detectServices } from '../cli/detect.js';
import { assembleContext } from '../framework/context.js';
import { buildOperatorSummary } from '../framework/operator-summary.js';
import type { AgentContext } from '../types/agent-context.js';

// ── MCP Protocol Types ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface McpServerInfo {
  name: string;
  version: string;
  capabilities: {
    tools: Record<string, never>;
  };
}

// ── Tool Definitions ──

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'crisismode_scan',
    description: 'Run a zero-config CrisisMode health scan. Returns a scored health summary with findings for all detected services.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string', description: 'Path to crisismode.yaml config file (optional — auto-detects if omitted)' },
        category: { type: 'string', description: 'Comma-separated agent categories to scan (e.g., "postgresql,redis")' },
      },
    },
  },
  {
    name: 'crisismode_diagnose',
    description: 'Run health assessment and AI-powered diagnosis for a specific target. Returns diagnosis findings, root cause analysis, and recovery recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target name from config (optional — uses first target if omitted)' },
        configPath: { type: 'string', description: 'Path to crisismode.yaml config file' },
      },
    },
  },
  {
    name: 'crisismode_status',
    description: 'Quick health status probe for all detected services. Returns UP/DOWN status for each service.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string', description: 'Path to crisismode.yaml config file' },
      },
    },
  },
  {
    name: 'crisismode_list_agents',
    description: 'List all available CrisisMode recovery agents and their capabilities.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── Tool Handlers ──

export async function handleScan(params: Record<string, unknown>): Promise<unknown> {
  const configPath = params.configPath as string | undefined;
  const category = params.category as string | undefined;

  let config;
  try {
    const result = loadConfig({ configPath });
    config = result.config;
  } catch {
    const services = await detectServices();
    const detected = services.filter((s) => s.detected);
    if (detected.length === 0) {
      return { score: 100, findings: [], scannedAt: new Date().toISOString(), message: 'No services detected' };
    }
    config = {
      apiVersion: 'crisismode/v1' as const,
      kind: 'SiteConfig' as const,
      metadata: { name: 'auto-detected', environment: 'development' as const },
      targets: detected.map((s) => ({
        name: `detected-${s.kind}`,
        kind: s.kind,
        primary: { host: s.host, port: s.port },
        replicas: [] as Array<{ host: string; port: number }>,
        credentials: { type: 'value' as const, username: '', password: '' },
      })),
    };
  }

  const registry = new AgentRegistry(config);
  const categories = category?.split(',').map((c) => c.trim()) ?? [];
  const findings: unknown[] = [];

  for (const target of config.targets) {
    if (categories.length > 0 && !categories.includes(target.kind)) continue;

    try {
      const { agent, backend } = await registry.createForTarget(target.name);
      const trigger: AgentContext['trigger'] = {
        type: 'health_check',
        source: 'mcp-scan',
        payload: { alertname: `${target.kind}Scan` },
        receivedAt: new Date().toISOString(),
      };
      const context = assembleContext(trigger, agent.manifest);

      const health = await Promise.race([
        agent.assessHealth(context),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]) as Awaited<ReturnType<typeof agent.assessHealth>>;

      findings.push({
        target: target.name,
        kind: target.kind,
        status: health.status,
        confidence: health.confidence,
        summary: health.summary,
        signals: health.signals,
      });

      await backend.close();
    } catch (err) {
      findings.push({
        target: target.name,
        kind: target.kind,
        status: 'unknown',
        confidence: 0,
        summary: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
        signals: [],
      });
    }
  }

  const healthyCount = findings.filter((f: any) => f.status === 'healthy').length;
  const score = findings.length > 0 ? Math.round((healthyCount / findings.length) * 100) : 100;

  return {
    score,
    findings,
    scannedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

export async function handleDiagnose(params: Record<string, unknown>): Promise<unknown> {
  const configPath = params.configPath as string | undefined;
  const targetName = params.target as string | undefined;

  const result = loadConfig({ configPath });
  const registry = new AgentRegistry(result.config);

  const { agent, backend, target } = targetName
    ? await registry.createForTarget(targetName)
    : await registry.createFirst();

  try {
    const trigger: AgentContext['trigger'] = {
      type: 'health_check',
      source: 'mcp-diagnose',
      payload: { alertname: `${target.kind}Diagnose` },
      receivedAt: new Date().toISOString(),
    };
    const context = assembleContext(trigger, agent.manifest);

    const health = await agent.assessHealth(context);
    const diagnosis = await agent.diagnose(context);

    const operatorSummary = buildOperatorSummary({
      health,
      mode: 'dry-run',
      healthCheckOnly: false,
    });

    return {
      target: target.name,
      kind: target.kind,
      health: {
        status: health.status,
        confidence: health.confidence,
        summary: health.summary,
        signals: health.signals,
      },
      diagnosis: {
        status: diagnosis.status,
        scenario: diagnosis.scenario,
        confidence: diagnosis.confidence,
        findings: diagnosis.findings,
      },
      operatorSummary: {
        actionRequired: operatorSummary.actionRequired,
        recommendedNextStep: operatorSummary.recommendedNextStep,
        recommendedActions: operatorSummary.recommendedActions,
      },
    };
  } finally {
    await backend.close();
  }
}

export async function handleStatus(params: Record<string, unknown>): Promise<unknown> {
  const configPath = params.configPath as string | undefined;

  let services;
  try {
    const result = loadConfig({ configPath });
    services = result.config.targets.map((t) => ({
      name: t.name,
      kind: t.kind,
      host: t.primary.host,
      port: t.primary.port,
    }));
  } catch {
    const detected = await detectServices();
    services = detected.map((s) => ({
      name: s.kind,
      kind: s.kind,
      host: s.host,
      port: s.port,
      detected: s.detected,
    }));
  }

  return { services, checkedAt: new Date().toISOString() };
}

export async function handleListAgents(): Promise<unknown> {
  const builtinAgents = [
    { kind: 'postgresql', name: 'pg-replication', description: 'PostgreSQL replication recovery' },
    { kind: 'redis', name: 'redis-memory', description: 'Redis memory pressure recovery' },
    { kind: 'etcd', name: 'etcd-consensus', description: 'etcd consensus recovery' },
    { kind: 'kafka', name: 'kafka-broker', description: 'Kafka broker recovery' },
    { kind: 'kubernetes', name: 'k8s-cluster', description: 'Kubernetes cluster recovery' },
    { kind: 'ceph', name: 'ceph-storage', description: 'Ceph storage recovery' },
    { kind: 'flink', name: 'flink-stream', description: 'Flink stream processing recovery' },
    { kind: 'deploy-rollback', name: 'deploy-rollback', description: 'Deployment rollback orchestration' },
    { kind: 'ai-provider', name: 'ai-provider', description: 'AI service failover and fallback' },
    { kind: 'db-migration', name: 'db-migration', description: 'Database migration safety' },
    { kind: 'queue-backlog', name: 'queue-backlog', description: 'Queue backlog recovery' },
    { kind: 'config-drift', name: 'config-drift', description: 'Configuration drift detection' },
  ];

  return { agents: builtinAgents, count: builtinAgents.length };
}

// ── MCP Server Core ──

const TOOL_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  crisismode_scan: handleScan,
  crisismode_diagnose: handleDiagnose,
  crisismode_status: handleStatus,
  crisismode_list_agents: handleListAgents,
};

export function buildInitializeResult(): McpServerInfo {
  return {
    name: 'crisismode',
    version: '0.2.0',
    capabilities: {
      tools: {},
    },
  };
}

export async function handleJsonRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: buildInitializeResult() };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };

    case 'tools/call': {
      const toolName = (params?.name ?? '') as string;
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }

      try {
        const result = await handler(toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        };
      }
    }

    case 'notifications/initialized':
      // Client acknowledgment — no response needed for notifications
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

/**
 * Start the MCP server on stdio.
 * Reads JSON-RPC messages from stdin (newline-delimited) and writes responses to stdout.
 */
export async function startMcpServer(): Promise<void> {
  process.stderr.write('CrisisMode MCP server starting on stdio...\n');

  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const request = JSON.parse(trimmed) as JsonRpcRequest;
        const response = await handleJsonRpcRequest(request);

        // Don't send response for notifications (no id)
        if (request.id !== undefined) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch (err) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    }
  });

  process.stdin.on('end', () => {
    process.stderr.write('CrisisMode MCP server shutting down.\n');
    process.exit(0);
  });
}
