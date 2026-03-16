// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Webhook receiver — accepts AlertManager webhook payloads and triggers
 * the recovery agent pipeline.
 *
 * Usage:
 *   pnpm run webhook                                  # dry-run mode (default)
 *   pnpm run webhook -- --execute                     # live execution mode
 *   pnpm run webhook -- --config crisismode.yaml      # explicit config path
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assembleContext } from './framework/context.js';
import { buildOperatorSummary } from './framework/operator-summary.js';
import { validatePlan } from './framework/validator.js';
import { matchCatalog } from './framework/catalog.js';
import { ForensicRecorder } from './framework/forensics.js';
import { ExecutionEngine, type ExecutionMode, type EngineCallbacks } from './framework/engine.js';
import { HubClient } from './framework/hub-client.js';
import { loadConfig, parseCliFlags } from './config/loader.js';
import { AgentRegistry } from './config/agent-registry.js';
import { resolveCredentials } from './config/credentials.js';
import { getFiringAlerts, validateAlertPayload, type AlertManagerAlert, type AlertManagerPayload } from './webhook-utils.js';
import type { AgentContext } from './types/agent-context.js';

export interface WebhookServerOptions {
  configPath?: string;
  execute?: boolean;
}

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// Module-level state — initialized by startWebhookServer or by direct execution
let MODE: ExecutionMode;
let config: ReturnType<typeof loadConfig>['config'];
let source: ReturnType<typeof loadConfig>['source'];
let filePath: ReturnType<typeof loadConfig>['filePath'];
let registry: AgentRegistry;
let PORT: number;
let WEBHOOK_SECRET: string;
let HUB_ENDPOINT: string;
let hubClient: HubClient;
const activeRecoveries = new Set<string>();

function initModule(options?: WebhookServerOptions): void {
  MODE = options?.execute ? 'execute' : 'dry-run';
  const result = loadConfig({ configPath: options?.configPath });
  config = result.config;
  source = result.source;
  filePath = result.filePath;
  registry = new AgentRegistry(config);
  PORT = config.webhook?.port ?? parseInt(process.env.PORT || '3000', 10);
  WEBHOOK_SECRET = config.webhook?.secret
    ? resolveCredentials(config.webhook.secret).token ?? ''
    : process.env.WEBHOOK_SECRET ?? '';
  HUB_ENDPOINT = config.hub?.endpoint ?? process.env.HUB_ENDPOINT ?? 'http://localhost:8080';
  hubClient = new HubClient({ endpoint: HUB_ENDPOINT });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

function isAuthenticated(req: IncomingMessage): boolean {
  if (!WEBHOOK_SECRET) return true; // No secret configured — allow all (dev mode)
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${WEBHOOK_SECRET}`;
}

async function handleAlerts(payload: AlertManagerPayload): Promise<{
  triggerId: string;
  outcome: string;
  steps: number;
  results?: Array<{
    triggerId: string;
    outcome: string;
    steps: number;
    error?: string;
  }>;
  error?: string;
}> {
  const firingAlerts = getFiringAlerts(payload);

  if (firingAlerts.length === 0) {
    return { triggerId: 'none', outcome: 'ignored', steps: 0 };
  }

  const results = [];
  for (const alert of firingAlerts) {
    results.push(await handleAlert(alert));
  }

  if (results.length === 1) {
    return results[0];
  }

  const totalSteps = results.reduce((sum, result) => sum + result.steps, 0);
  const anyError = results.some((result) => result.outcome === 'error' || result.outcome === 'validation_failed');
  const anyPartial = results.some(
    (result) => result.outcome === 'partial_success' || result.outcome === 'deduplicated',
  );

  return {
    triggerId: 'batch',
    outcome: anyError ? 'partial_success' : anyPartial ? 'partial_success' : 'success',
    steps: totalSteps,
    results,
  };
}

async function handleAlert(alert: AlertManagerAlert): Promise<{
  triggerId: string;
  outcome: string;
  steps: number;
  error?: string;
}> {
  const triggerId = `${alert.labels.alertname}-${alert.startsAt}`;

  // Deduplicate
  if (activeRecoveries.has(triggerId)) {
    log(`  ⏭️  Recovery already active for ${triggerId}`);
    return { triggerId, outcome: 'deduplicated', steps: 0 };
  }

  // Dispatch to the right agent via registry
  const instance = await registry.dispatchAlert(alert.labels);
  if (!instance) {
    log(`  ⏭️  No agent matches alert: ${alert.labels.alertname}`);
    return { triggerId, outcome: 'no_matching_agent', steps: 0 };
  }

  activeRecoveries.add(triggerId);
  log(`  🔥 Alert: ${alert.labels.alertname} → agent: ${instance.agent.manifest.metadata.name}`);

  const { agent, backend, target } = instance;

  try {
    // Build trigger from AlertManager payload
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'prometheus',
      payload: {
        alertname: alert.labels.alertname,
        instance: alert.labels.instance || `${target.primary.host}:${target.primary.port}`,
        severity: alert.labels.severity || 'critical',
        ...alert.labels,
      },
      receivedAt: new Date().toISOString(),
    };

    const context = assembleContext(trigger, agent.manifest);
    const initialHealth = await agent.assessHealth(context);
    log(`  🩺 Health: ${initialHealth.status} (${(initialHealth.confidence * 100).toFixed(0)}% confidence)`);
    log(`  🩺 Summary: ${initialHealth.summary}`);
    if (initialHealth.status === 'healthy') {
      log('  ✅ Direct health probe indicates the system is healthy. Skipping recovery for this alert.');
      return { triggerId, outcome: 'healthy_no_action', steps: 0 };
    }

    // Diagnose
    log('  🔍 Running diagnosis...');
    const diagnosis = await agent.diagnose(context);
    log(`  📋 Diagnosis: ${diagnosis.scenario} (${(diagnosis.confidence * 100).toFixed(0)}% confidence)`);

    // Plan
    const plan = await agent.plan(context, diagnosis);
    log(`  📝 Plan: ${plan.steps.length} steps — ${plan.metadata.summary}`);

    // Validate
    const validation = validatePlan(plan, agent.manifest, {
      backend,
      executionMode: MODE,
      requireExecutableCapabilities: MODE === 'execute',
    });
    const executeReadinessValidation = validatePlan(plan, agent.manifest, {
      backend,
      executionMode: 'execute',
      requireExecutableCapabilities: true,
    });
    const providerResolutionCheck = validation.checks.find(
      (check) => check.name === 'Provider resolution for live execution',
    );
    if (providerResolutionCheck) {
      log(`  🔌 ${providerResolutionCheck.message}`);
    }
    if (!validation.valid) {
      log(`  ❌ Plan validation failed`);
      const blockedHealth = await agent.assessHealth(context);
      const blockedSummary = buildOperatorSummary({
        health: blockedHealth,
        mode: MODE,
        currentValidation: validation,
        executeValidation: executeReadinessValidation,
      });
      log(`  🧭 Operator summary: ${blockedSummary.summary}`);
      log(`  🧭 Next step: ${blockedSummary.recommendedNextStep}`);
      return { triggerId, outcome: 'validation_failed', steps: 0, error: 'Plan validation failed' };
    }

    // Catalog match
    const catalogMatch = matchCatalog(plan);

    // Execute
    const recorder = new ForensicRecorder();
    recorder.setContext(context);
    recorder.setDiagnosis(diagnosis);
    recorder.addPlan(plan);
    recorder.setCatalogMatchUsed(catalogMatch.matched);

    const callbacks: EngineCallbacks = {
      onStepStart: (s, i) => log(`  ▶️  Step ${s.stepId} [${s.type}]: ${s.name}`),
      onStepComplete: (s, result) => {
        const icon = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : '⏭️';
        log(`  ${icon} Step ${s.stepId}: ${result.status} (${result.durationMs}ms)`);
      },
    };

    const engine = new ExecutionEngine(
      context,
      agent.manifest,
      agent,
      recorder,
      backend,
      callbacks,
      MODE,
    );
    engine.setCoveredRiskLevels(catalogMatch.coveredRiskLevels);

    log(`  🚀 Executing plan in ${MODE} mode...`);
    const results = await engine.executePlan(plan, diagnosis);
    const finalHealth = await agent.assessHealth(context);
    const finalSummary = buildOperatorSummary({
      health: finalHealth,
      mode: MODE,
      currentValidation: validation,
      executeValidation: executeReadinessValidation,
      results,
    });
    log(`  🧭 Operator summary: ${finalSummary.summary}`);
    log(`  🧭 Next step: ${finalSummary.recommendedNextStep}`);

    // Write forensic record locally and submit to hub
    const outputPath = `output/forensic-${triggerId.replace(/[^a-zA-Z0-9-]/g, '_')}.json`;
    const record = recorder.writeToFile(outputPath);
    log(`  📋 Forensic record: ${outputPath}`);

    try {
      const hubResult = await hubClient.submitForensicRecord(record);
      log(`  📤 Submitted to hub: ${hubResult.recordId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`  ⚠️  Hub submission failed (record saved locally): ${errMsg}`);
    }

    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    log(`  📊 Results: ${succeeded} succeeded, ${failed} failed out of ${results.length} steps`);

    return {
      triggerId,
      outcome: failed > 0 ? 'partial_success' : 'success',
      steps: results.length,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`  ❌ Recovery failed: ${errMsg}`);
    return { triggerId, outcome: 'error', steps: 0, error: errMsg };
  } finally {
    await backend.close();
    activeRecoveries.delete(triggerId);
  }
}

/**
 * Start the webhook server — extracted for CLI reuse.
 */
export async function startWebhookServer(options?: WebhookServerOptions): Promise<void> {
  initModule(options);
  return new Promise((_resolve) => {
    createWebhookServer();
  });
}

function createWebhookServer(): void {
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = req.url?.split('?')[0];

  // AlertManager webhook endpoint
  if (req.method === 'POST' && path === '/api/v1/alerts') {
    if (!isAuthenticated(req)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const body = await readBody(req);
      const parsed: unknown = JSON.parse(body);

      if (!validateAlertPayload(parsed)) {
        json(res, 400, { error: 'invalid alert payload: expected object with alerts array' });
        return;
      }

      const payload = parsed;

      log(`📨 Received ${payload.alerts.length} alert(s) (status: ${payload.status})`);

      // Handle resolved alerts
      if (payload.status === 'resolved') {
        log('  ✅ Alert resolved — no action needed');
        json(res, 200, { status: 'resolved', action: 'none' });
        return;
      }

      const result = await handleAlerts(payload);
      json(res, 200, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`❌ Error processing alert: ${errMsg}`);
      json(res, 500, { error: errMsg });
    }
    return;
  }

  // Health check — minimal, no internal state
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, { status: 'ok' });
    return;
  }

  // Debug — detailed status, requires authentication
  if (req.method === 'GET' && path === '/debug') {
    if (!isAuthenticated(req)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    json(res, 200, {
      status: 'ok',
      mode: MODE,
      uptime: process.uptime(),
      activeRecoveries: [...activeRecoveries],
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CrisisMode Spoke — Webhook Receiver');
  console.log('');
  console.log(`  Config:   ${source === 'file' ? filePath : 'env-var fallback'}`);
  console.log(`  Targets:  ${config.targets.map((t) => `${t.name} (${t.kind})`).join(', ')}`);
  console.log(`  Mode:     ${MODE === 'execute' ? '🔴 EXECUTE (mutations enabled)' : '🟡 DRY-RUN (read-only)'}`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Endpoint: http://localhost:${PORT}/api/v1/alerts`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  Auth:     ${WEBHOOK_SECRET ? '🔐 WEBHOOK_SECRET configured' : '⚠️  No WEBHOOK_SECRET (dev mode, all requests accepted)'}`);
  console.log('');
  console.log('  Waiting for AlertManager webhooks...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});
} // end createWebhookServer

// Direct execution entry point (backward compat for `pnpm run webhook`)
const isDirectExecution = process.argv[1]?.endsWith('webhook.ts') || process.argv[1]?.endsWith('webhook.js');
if (isDirectExecution) {
  const execMode = process.argv.includes('--execute');
  const { configPath } = parseCliFlags(process.argv);
  startWebhookServer({ configPath, execute: execMode });
}
