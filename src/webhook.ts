// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Webhook receiver — accepts AlertManager webhook payloads and triggers
 * the recovery agent pipeline.
 *
 * Usage:
 *   pnpm run webhook                          # dry-run mode (default)
 *   pnpm run webhook --execute                # live execution mode
 *   PORT=3000 pnpm run webhook                # custom port
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PgReplicationAgent } from './agent/pg-replication/agent.js';
import { PgLiveClient } from './agent/pg-replication/live-client.js';
import { assembleContext } from './framework/context.js';
import { validatePlan } from './framework/validator.js';
import { matchCatalog } from './framework/catalog.js';
import { ForensicRecorder } from './framework/forensics.js';
import { ExecutionEngine, type ExecutionMode, type EngineCallbacks } from './framework/engine.js';
import { HubClient } from './framework/hub-client.js';
import type { AgentContext } from './types/agent-context.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const MODE: ExecutionMode = process.argv.includes('--execute') ? 'execute' : 'dry-run';
const HUB_ENDPOINT = process.env.HUB_ENDPOINT || 'http://localhost:8080';

// Hub client for forensic record submission
const hubClient = new HubClient({ endpoint: HUB_ENDPOINT });

// PostgreSQL connection config from environment
const pgConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'crisismode',
  password: process.env.PG_PASSWORD || 'crisismode',
  database: process.env.PG_DATABASE || 'crisismode',
};

const pgReplicaConfig = {
  ...pgConfig,
  port: parseInt(process.env.PG_REPLICA_PORT || '5433', 10),
};

// Track active recoveries to prevent duplicate runs
const activeRecoveries = new Set<string>();

interface AlertManagerPayload {
  version: string;
  status: string;
  alerts: Array<{
    status: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    generatorURL?: string;
  }>;
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
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

async function handleAlert(payload: AlertManagerPayload): Promise<{
  triggerId: string;
  outcome: string;
  steps: number;
  error?: string;
}> {
  // Find the first firing PostgreSQL replication alert
  const firingAlerts = payload.alerts.filter(
    (a) => a.status === 'firing' && a.labels.alertname?.includes('PostgresReplication'),
  );

  if (firingAlerts.length === 0) {
    return { triggerId: 'none', outcome: 'ignored', steps: 0 };
  }

  const alert = firingAlerts[0];
  const triggerId = `${alert.labels.alertname}-${alert.startsAt}`;

  // Deduplicate
  if (activeRecoveries.has(triggerId)) {
    log(`  ⏭️  Recovery already active for ${triggerId}`);
    return { triggerId, outcome: 'deduplicated', steps: 0 };
  }

  activeRecoveries.add(triggerId);
  log(`  🔥 Alert: ${alert.labels.alertname} — ${alert.annotations.summary || 'no summary'}`);

  const liveClient = new PgLiveClient(pgConfig, pgReplicaConfig);

  try {
    // Build trigger from AlertManager payload
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'prometheus',
      payload: {
        alertname: alert.labels.alertname,
        instance: alert.labels.instance || `${pgConfig.host}:${pgConfig.port}`,
        severity: alert.labels.severity || 'critical',
        ...alert.labels,
      },
      receivedAt: new Date().toISOString(),
    };

    const agent = new PgReplicationAgent(liveClient);
    const context = assembleContext(trigger, agent.manifest);

    // Diagnose
    log('  🔍 Running diagnosis...');
    const diagnosis = await agent.diagnose(context);
    log(`  📋 Diagnosis: ${diagnosis.scenario} (${(diagnosis.confidence * 100).toFixed(0)}% confidence)`);

    // Plan
    const plan = await agent.plan(context, diagnosis);
    log(`  📝 Plan: ${plan.steps.length} steps — ${plan.metadata.summary}`);

    // Validate
    const validation = validatePlan(plan, agent.manifest);
    if (!validation.valid) {
      log(`  ❌ Plan validation failed`);
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
      liveClient,
      callbacks,
      MODE,
    );
    engine.setCoveredRiskLevels(catalogMatch.coveredRiskLevels);

    log(`  🚀 Executing plan in ${MODE} mode...`);
    const results = await engine.executePlan(plan, diagnosis);

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
    await liveClient.close();
    activeRecoveries.delete(triggerId);
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = req.url?.split('?')[0];

  // AlertManager webhook endpoint
  if (req.method === 'POST' && path === '/api/v1/alerts') {
    try {
      const body = await readBody(req);
      const payload: AlertManagerPayload = JSON.parse(body);

      log(`📨 Received ${payload.alerts?.length ?? 0} alert(s) (status: ${payload.status})`);

      // Handle resolved alerts
      if (payload.status === 'resolved') {
        log('  ✅ Alert resolved — no action needed');
        json(res, 200, { status: 'resolved', action: 'none' });
        return;
      }

      const result = await handleAlert(payload);
      json(res, 200, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`❌ Error processing alert: ${errMsg}`);
      json(res, 500, { error: errMsg });
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, {
      status: 'ok',
      mode: MODE,
      uptime: process.uptime(),
      activeRecoveries: activeRecoveries.size,
      pg: { host: pgConfig.host, port: pgConfig.port },
    });
    return;
  }

  // Status — list active recoveries
  if (req.method === 'GET' && path === '/status') {
    json(res, 200, {
      mode: MODE,
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
  console.log(`  Mode:     ${MODE === 'execute' ? '🔴 EXECUTE (mutations enabled)' : '🟡 DRY-RUN (read-only)'}`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Endpoint: http://localhost:${PORT}/api/v1/alerts`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  PG:       ${pgConfig.host}:${pgConfig.port}`);
  console.log('');
  console.log('  Waiting for AlertManager webhooks...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});
