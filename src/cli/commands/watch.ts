// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode watch` — shadow/continuous observation mode.
 * Runs periodic health checks and produces recovery proposals proactively.
 * Safe to run indefinitely — never mutates infrastructure.
 */

import { assembleContext } from '../../framework/context.js';
import { buildOperatorSummary } from '../../framework/operator-summary.js';
import { loadConfig, parseCliFlags } from '../../config/loader.js';
import { AgentRegistry } from '../../config/agent-registry.js';
import { detectServices } from '../detect.js';
import { generateDiagnosisReport } from '../../framework/incident-report.js';
import {
  printBanner, printHealthStatus, printInfo, printSuccess,
  printWarning, printError, printDetection,
} from '../output.js';
import { noConfig, formatError } from '../errors.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { HealthStatus } from '../../types/health.js';

export interface WatchOptions {
  configPath?: string;
  targetName?: string;
  intervalMs?: number;
  maxCycles?: number;
}

interface HealthTransition {
  from: HealthStatus;
  to: HealthStatus;
  timestamp: string;
}

interface WatchSummary {
  totalCycles: number;
  healthTransitions: HealthTransition[];
  proposalsGenerated: number;
  startedAt: string;
  endedAt: string;
}

const DEFAULT_INTERVAL_MS = 30_000;

export async function runWatch(opts: WatchOptions): Promise<void> {
  printBanner();

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Load config or detect
  let config;
  let source: string;
  try {
    const result = loadConfig({ configPath: opts.configPath });
    config = result.config;
    source = result.source === 'file' ? result.filePath ?? 'crisismode.yaml' : 'env-var fallback';
  } catch {
    printInfo('No configuration found, scanning localhost...');
    const services = await detectServices();
    printDetection(services);

    const detected = services.filter((s) => s.detected);
    if (detected.length === 0) {
      throw noConfig();
    }

    config = buildConfigFromDetection(detected);
    source = 'auto-detected';
  }

  printInfo(`Config: ${source}`);
  console.log('');

  const registry = new AgentRegistry(config);
  const { agent, backend, target } = opts.targetName
    ? await registry.createForTarget(opts.targetName)
    : await registry.createFirst();

  await AgentRegistry.discoverVersion({ agent, backend, target });

  const intervalSec = (intervalMs / 1000).toFixed(0);
  printInfo(`Shadow mode active — observing ${target.name} every ${intervalSec}s`);
  console.log('');

  const summary: WatchSummary = {
    totalCycles: 0,
    healthTransitions: [],
    proposalsGenerated: 0,
    startedAt: new Date().toISOString(),
    endedAt: '',
  };

  let lastStatus: HealthStatus | null = null;
  let running = true;

  const handleShutdown = (): void => {
    running = false;
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    while (running) {
      if (opts.maxCycles !== undefined && summary.totalCycles >= opts.maxCycles) {
        break;
      }

      summary.totalCycles++;

      const trigger: AgentContext['trigger'] = {
        type: 'health_check',
        source: 'cli-watch',
        payload: {
          alertname: `${target.kind}WatchCheck`,
          instance: `${target.primary.host}:${target.primary.port}`,
          severity: 'info',
          cycle: summary.totalCycles,
        },
        receivedAt: new Date().toISOString(),
      };

      const context = assembleContext(trigger, agent.manifest);

      try {
        const health = await agent.assessHealth(context);
        const timestamp = new Date().toISOString();
        const confidencePct = (health.confidence * 100).toFixed(0);

        // Compact one-line status
        printInfo(`[${timestamp}] ${health.status.toUpperCase()} (${confidencePct}% confidence)`);

        // Track health transitions
        if (lastStatus !== null && lastStatus !== health.status) {
          summary.healthTransitions.push({
            from: lastStatus,
            to: health.status,
            timestamp,
          });
        }

        // If transitioned from healthy to unhealthy, generate a recovery proposal
        if (lastStatus === 'healthy' && health.status === 'unhealthy') {
          printWarning('Health transitioned from healthy to unhealthy — generating recovery proposal...');
          console.log('');

          const diagnosis = await agent.diagnose(context);
          const plan = await agent.plan(context, diagnosis);

          const operatorSummary = buildOperatorSummary({
            health,
            mode: 'dry-run',
            healthCheckOnly: false,
          });

          const report = generateDiagnosisReport(diagnosis, health, operatorSummary);
          console.log(report.markdown);
          console.log('');

          summary.proposalsGenerated++;
          printWarning('Recovery proposal ready. Run `crisismode recover` to execute.');
          console.log('');
        }

        lastStatus = health.status;
      } catch (err) {
        printError(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Sleep for the interval, but check running flag periodically
      if (running && (opts.maxCycles === undefined || summary.totalCycles < opts.maxCycles)) {
        await sleep(intervalMs);
      }
    }
  } finally {
    process.removeListener('SIGINT', handleShutdown);
    process.removeListener('SIGTERM', handleShutdown);
    await backend.close();
  }

  summary.endedAt = new Date().toISOString();
  printWatchSummary(summary);
}

function printWatchSummary(summary: WatchSummary): void {
  console.log('');
  printInfo('--- Observation Summary ---');
  printInfo(`Total cycles:         ${summary.totalCycles}`);
  printInfo(`Health transitions:   ${summary.healthTransitions.length}`);
  printInfo(`Proposals generated:  ${summary.proposalsGenerated}`);
  printInfo(`Started:              ${summary.startedAt}`);
  printInfo(`Ended:                ${summary.endedAt}`);

  if (summary.healthTransitions.length > 0) {
    console.log('');
    printInfo('Health transitions:');
    for (const t of summary.healthTransitions) {
      printInfo(`  ${t.timestamp}: ${t.from} -> ${t.to}`);
    }
  }

  console.log('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildConfigFromDetection(detected: Array<{ kind: string; host: string; port: number }>) {
  return {
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
