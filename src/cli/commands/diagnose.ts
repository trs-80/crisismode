// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode diagnose` — read-only health check and diagnosis.
 * Safe to run at any time — never mutates infrastructure.
 */

import { assembleContext } from '../../framework/context.js';
import { buildOperatorSummary } from '../../framework/operator-summary.js';
import { loadConfig, parseCliFlags } from '../../config/loader.js';
import { AgentRegistry } from '../../config/agent-registry.js';
import { detectServices } from '../detect.js';
import {
  printBanner, printHealthStatus, printDiagnosis, printOperatorSummary,
  printInfo, printSuccess, printWarning, printDetection,
} from '../output.js';
import { noConfig, formatError } from '../errors.js';
import type { AgentContext } from '../../types/agent-context.js';

export interface DiagnoseOptions {
  configPath?: string;
  targetName?: string;
}

export async function runDiagnose(opts: DiagnoseOptions): Promise<void> {
  printBanner();

  // Load config or detect
  let config;
  let source: string;
  try {
    const result = loadConfig({ configPath: opts.configPath });
    config = result.config;
    source = result.source === 'file' ? result.filePath ?? 'crisismode.yaml' : 'env-var fallback';
  } catch {
    // No config — try detection
    printInfo('No configuration found, scanning localhost...');
    const services = await detectServices();
    printDetection(services);

    const detected = services.filter((s) => s.detected);
    if (detected.length === 0) {
      throw noConfig();
    }

    // Build minimal config from detection
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

  printInfo(`Target: ${target.name} (${target.kind})`);
  console.log('');

  try {
    // Build a trigger context for diagnosis
    const trigger: AgentContext['trigger'] = {
      type: 'alert',
      source: 'cli-diagnose',
      payload: {
        alertname: `${target.kind}HealthCheck`,
        instance: `${target.primary.host}:${target.primary.port}`,
        severity: 'info',
      },
      receivedAt: new Date().toISOString(),
    };

    const context = assembleContext(trigger, agent.manifest);

    // Health assessment
    printInfo('Assessing health...');
    const health = await agent.assessHealth(context);
    printHealthStatus(health);

    if (health.status === 'healthy') {
      printSuccess('System is healthy. No issues detected.');
      printOperatorSummary(buildOperatorSummary({
        health,
        mode: 'dry-run',
        healthCheckOnly: true,
      }));
      return;
    }

    // Diagnosis (read-only)
    const hasAiKey = !!process.env.ANTHROPIC_API_KEY;
    printInfo(hasAiKey ? 'Running AI-powered diagnosis...' : 'Running rule-based diagnosis...');

    const diagnosis = await agent.diagnose(context);
    printDiagnosis(diagnosis);

    printOperatorSummary(buildOperatorSummary({
      health,
      mode: 'dry-run',
      healthCheckOnly: true,
    }));

    if (health.status === 'unhealthy') {
      printWarning('Run `crisismode recover` to generate and execute a recovery plan.');
    }
  } finally {
    await backend.close();
  }
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
