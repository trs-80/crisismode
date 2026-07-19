// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CrisisMode MCP (Model Context Protocol) Server
 *
 * Exposes CrisisMode's read-only diagnosis capabilities as MCP tools so AI
 * agents (Claude Code, Claude Desktop, any MCP client) can scan, diagnose,
 * and analyze incident evidence on the operator's own infrastructure.
 *
 * Built on the official @modelcontextprotocol/sdk (stdio transport).
 *
 * Tools exposed (all read-only — this surface never mutates infrastructure):
 * - crisismode_scan           — zero-config health scan with scored findings
 * - crisismode_diagnose       — health assessment + diagnosis for one target
 * - crisismode_status         — quick UP/DOWN probe of configured/detected services
 * - crisismode_list_agents    — the built-in recovery agent roster
 * - crisismode_bundle_ingest  — read-only diagnosis of an SRE evidence bundle (v1)
 * - crisismode_bundle_respond — full AdapterResponse v1 for an evidence bundle
 * - crisismode_bundle_plan    — translate a bundle to a dry-run RecoveryPlan
 * - crisismode_readiness      — forward-looking scale-readiness report
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config/loader.js';
import { AgentRegistry } from '../config/agent-registry.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { detectServices } from '../cli/detect.js';
import { assembleContext } from '../framework/context.js';
import { applyEnvironmentGuard } from '../framework/environment-guard.js';
import { getNetworkProfile, probeNetwork } from '../framework/network-profile.js';
import { buildOperatorSummary } from '../framework/operator-summary.js';
import { ingestEvidenceBundle } from '../framework/evidence-bundle-ingest.js';
import { respondToEvidenceBundle } from '../framework/evidence-bundle-respond.js';
import { adapterResponseToPlan } from '../framework/bundle-to-plan.js';
import { runReadiness } from '../readiness/run.js';
import type { AgentContext } from '../types/agent-context.js';

// ── Tool Handlers ──

export async function handleScan(params: Record<string, unknown>): Promise<unknown> {
  const configPath = params.configPath as string | undefined;
  const category = params.category as string | undefined;

  let config;
  try {
    const result = loadConfig(configPath !== undefined ? { configPath } : {});
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
  const findings: Array<{ status: string }> = [];

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
      } as never);

      await backend.close();
    } catch (err) {
      findings.push({
        target: target.name,
        kind: target.kind,
        status: 'unknown',
        confidence: 0,
        summary: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
        signals: [],
      } as never);
    }
  }

  const healthyCount = findings.filter((f) => f.status === 'healthy').length;
  const score = findings.length > 0 ? Math.round((healthyCount / findings.length) * 100) : 100;

  return {
    score,
    findings,
    scannedAt: new Date().toISOString(),
  };
}

export async function handleDiagnose(params: Record<string, unknown>): Promise<unknown> {
  const configPath = params.configPath as string | undefined;
  const targetName = params.target as string | undefined;

  const result = loadConfig(configPath !== undefined ? { configPath } : {});
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
    const targetProbes = result.config.targets
      .filter((t) => t.primary)
      .map((t) => ({ host: t.primary!.host, port: t.primary!.port, label: t.name }));
    const networkProfile = getNetworkProfile() ?? await probeNetwork({ targets: targetProbes });
    const diagnosis = applyEnvironmentGuard(
      await agent.diagnose(context),
      networkProfile,
      target.name,
    );

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
    const result = loadConfig(configPath !== undefined ? { configPath } : {});
    services = result.config.targets.map((t) => ({
      name: t.name,
      kind: t.kind,
      host: t.primary?.host ?? t.aws?.region ?? 'aws',
      port: t.primary?.port ?? 0,
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
  const agents = builtinAgents.map((registration) => ({
    kind: registration.kind,
    name: registration.name,
    description: registration.manifest.metadata.description,
  }));
  return { agents, count: agents.length };
}

/** Accept an evidence bundle as either a JSON string or an already-parsed object. */
function parseBundle(bundle: string | Record<string, unknown>): unknown {
  if (typeof bundle !== 'string') return bundle;
  try {
    return JSON.parse(bundle);
  } catch (err) {
    throw new Error(`bundle is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

export async function handleBundleIngest(params: { bundle: string | Record<string, unknown> }): Promise<unknown> {
  const bundle = parseBundle(params.bundle);
  return ingestEvidenceBundle(bundle as never);
}

export async function handleBundleRespond(params: { bundle: string | Record<string, unknown> }): Promise<unknown> {
  const bundle = parseBundle(params.bundle);
  const { response } = await respondToEvidenceBundle(bundle as never);
  return response;
}

export async function handleBundlePlan(params: { bundle: string | Record<string, unknown> }): Promise<unknown> {
  const bundle = parseBundle(params.bundle);
  const respondResult = await respondToEvidenceBundle(bundle as never);
  const planResult = adapterResponseToPlan(bundle as never, respondResult.response);
  return {
    plan: planResult.plan,
    rejected: planResult.rejected,
    warnings: planResult.warnings,
    response_state: respondResult.response.state,
  };
}

// ── Server Assembly ──

const bundleInput = {
  bundle: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .describe('SRE evidence bundle v1 (incident-generator.agent-adapter-request/v1), as a JSON string or object'),
};

/** Wrap handler output as an MCP tool result: human-readable text + machine-readable structure. */
function toResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function serverVersion(): string {
  return process.env.__CRISISMODE_VERSION ?? '0.5.0';
}

/**
 * Build the CrisisMode MCP server with all read-only diagnosis tools registered.
 * Transport-agnostic — callers connect it to stdio (production) or an
 * in-memory pair (tests).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'crisismode', version: serverVersion() });

  server.registerTool(
    'crisismode_scan',
    {
      title: 'Health scan',
      description:
        'Run a zero-config CrisisMode health scan. Detects local services (PostgreSQL, Redis, Kafka, etcd, Kubernetes, AWS, ...) or uses crisismode.yaml, checks health, and returns a 0-100 score with per-service findings. Read-only.',
      inputSchema: {
        configPath: z.string().optional().describe('Path to crisismode.yaml (auto-detects if omitted)'),
        category: z.string().optional().describe('Comma-separated service kinds to scan, e.g. "postgresql,redis"'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => toResult(await handleScan(args)),
  );

  server.registerTool(
    'crisismode_diagnose',
    {
      title: 'Diagnose a target',
      description:
        'Health assessment plus diagnosis for one target: root-cause findings, confidence, and recommended next steps. Uses AI diagnosis when ANTHROPIC_API_KEY is set, rule-based heuristics otherwise. Read-only — never mutates the target.',
      inputSchema: {
        target: z.string().optional().describe('Target name from config (first target if omitted)'),
        configPath: z.string().optional().describe('Path to crisismode.yaml'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => toResult(await handleDiagnose(args)),
  );

  server.registerTool(
    'crisismode_status',
    {
      title: 'Quick status probe',
      description: 'Quick UP/DOWN status of configured or auto-detected services. Read-only.',
      inputSchema: {
        configPath: z.string().optional().describe('Path to crisismode.yaml'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => toResult(await handleStatus(args)),
  );

  server.registerTool(
    'crisismode_list_agents',
    {
      title: 'List recovery agents',
      description: 'List the built-in CrisisMode recovery agents and what each one diagnoses.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => toResult(await handleListAgents()),
  );

  server.registerTool(
    'crisismode_bundle_ingest',
    {
      title: 'Ingest evidence bundle',
      description:
        'Read-only diagnosis of an SRE evidence bundle (v1): validates the bundle and returns a DiagnosisResult from the routed recovery agent.',
      inputSchema: bundleInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => toResult(await handleBundleIngest(args)),
  );

  server.registerTool(
    'crisismode_bundle_respond',
    {
      title: 'Respond to evidence bundle',
      description:
        'Full AdapterResponse v1 for an SRE evidence bundle: ranked hypotheses with evidence citations, policy-gated proposed actions, and explicit abstention when evidence is insufficient. Abstains rather than guessing when AI is unavailable.',
      inputSchema: bundleInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => toResult(await handleBundleRespond(args)),
  );

  server.registerTool(
    'crisismode_bundle_plan',
    {
      title: 'Bundle to dry-run plan',
      description:
        'Translate an SRE evidence bundle into a validated CrisisMode RecoveryPlan (dry-run only — the plan is returned, never executed). Includes policy-rejected actions and warnings.',
      inputSchema: bundleInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => toResult(await handleBundlePlan(args)),
  );

  server.registerTool(
    'crisismode_readiness',
    {
      title: 'Scale-readiness report',
      description:
        'Forward-looking scale-readiness check for the detected stack (serverless + PostgreSQL): connection headroom, pooling, indexes, slow queries. Returns a scored report with plain-English findings and fixes, plus capacity ceilings (labeled upper bounds) and a conditional weak-link verdict. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => toResult(await runReadiness()),
  );

  return server;
}

/**
 * Start the MCP server on stdio.
 *
 * stdout carries the MCP protocol exclusively, so any stray console.log from
 * framework code is rerouted to stderr before the transport connects.
 */
export async function startMcpServer(): Promise<void> {
   
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);
  console.debug = (...args: unknown[]) => console.error(...args);
   

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('crisismode MCP server ready on stdio\n');
}
